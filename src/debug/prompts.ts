import type { Hypothesis, RunLedger } from "./types.js";

export const SUMMARY_JSON_SCHEMA = `{
  "bugSummary": "string",
  "rootCause": "string",
  "fixExplanation": "string",
  "risks": ["string"],
  "followUps": ["string"]
}`;

export interface PromptContext {
  ledger: RunLedger;
  logSnippet?: string;
  sinceTs?: number;
}

function hypothesesBlock(hypotheses: Hypothesis[]): string {
  if (hypotheses.length === 0) return "(none yet)";
  return hypotheses
    .map(
      (h) =>
        `- ${h.id} [${h.status}] rank=${h.rank}: ${h.statement}` +
        (h.file ? ` @ ${h.file}${h.line != null ? `:${h.line}` : ""}` : ""),
    )
    .join("\n");
}

export function promptHypothesize(ctx: PromptContext): string {
  const { ledger } = ctx;
  return `You are in DEBUG emulation — HYPOTHESIZE phase.

Bug description:
${ledger.bugDescription}

App URL: ${ledger.url}
Repo: ${ledger.repoPath}
Run ID: ${ledger.runId}

Tasks:
1. Read the codebase relevant to this bug.
2. Propose 3-5 ranked hypotheses with specific file/line targets.
3. Use cursor/update_todos to record each hypothesis as a todo (id H1, H2, ...).
4. Do NOT edit any files in this phase.

When done, end your reply with a JSON block:
\`\`\`json
{"hypotheses":[{"id":"H1","rank":1,"statement":"...","file":"path","line":42}]}
\`\`\``;
}

export function promptInstrument(ctx: PromptContext): string {
  const { ledger } = ctx;
  return `DEBUG emulation — INSTRUMENT phase.

Run ID: ${ledger.runId}
Hypotheses:
${hypothesesBlock(ledger.hypotheses)}

Add minimal JSONL logging to: ${ledger.repoPath}/.cursor/debug.log

Each log line MUST be one JSON object:
{"hypothesis":"H#","file":"relative/path","line":N,"value":<any>,"ts":<unix-ms>}

Wrap EVERY instrumentation edit with sentinel comment:
// DEBUG-INSTRUMENT:${ledger.runId}

Do not change program behavior beyond logging. Track files you touch.

When done, reply with:
\`\`\`json
{"filesTouched":["path/to/file.ts"]}
\`\`\``;
}

export function promptReproduce(ctx: PromptContext): string {
  const { ledger } = ctx;
  return `DEBUG emulation — REPRODUCE phase.

Use the chrome-devtools MCP server to reproduce the bug.

URL: ${ledger.url}
Bug: ${ledger.bugDescription}

Steps:
1. Open the URL in Chrome via chrome-devtools MCP.
2. Perform actions that trigger the bug.
3. Confirm runtime data was written to ${ledger.repoPath}/.cursor/debug.log

When done, reply with:
\`\`\`json
{"steps":["step 1","step 2"],"logCaptured":true}
\`\`\``;
}

export function promptAnalyze(ctx: PromptContext): string {
  const { ledger, logSnippet, sinceTs } = ctx;
  return `DEBUG emulation — ANALYZE phase.

Hypotheses:
${hypothesesBlock(ledger.hypotheses)}

Read ${ledger.repoPath}/.cursor/debug.log entries since ts=${sinceTs ?? 0}.

Log snippet:
${logSnippet ?? "(read the file)"}

Identify which hypothesis is CONFIRMED. Propose a precise minimal fix (file, line range, code). Do NOT apply the fix yet.

End with:
\`\`\`json
{"confirmedHypothesis":"H1","fixProposal":"description","files":["path"]}
\`\`\``;
}

export function promptApplyFix(ctx: PromptContext): string {
  const { ledger } = ctx;
  return `DEBUG emulation — APPLY FIX phase.

Confirmed: ${ledger.confirmedHypothesisId ?? "see analysis"}
Proposal: ${ledger.fixProposed ?? "see prior analysis"}

Apply the minimal fix. Keep instrumentation sentinels (// DEBUG-INSTRUMENT:${ledger.runId}) in place.

Reply when done with:
\`\`\`json
{"applied":true,"files":["path"]}
\`\`\``;
}

export function promptVerify(ctx: PromptContext): string {
  const { ledger } = ctx;
  return `DEBUG emulation — VERIFY phase.

Reproduce the bug scenario using chrome-devtools MCP at ${ledger.url}.
The fix should prevent the original failure.

If verification passes:
\`\`\`json
{"verified":true}
\`\`\`

If it still fails:
\`\`\`json
{"verified":false,"reason":"..."}
\`\`\``;
}

export function promptMarkFixed(ctx: PromptContext): string {
  const { ledger } = ctx;
  return `DEBUG emulation — MARK FIXED (cleanup instrumentation).

Bug is verified fixed. Remove ALL lines/edits containing:
// DEBUG-INSTRUMENT:${ledger.runId}

Delete ${ledger.repoPath}/.cursor/debug.log if it only contains debug instrumentation data.
Do not revert the actual bug fix.

Reply with:
\`\`\`json
{"cleaned":true}
\`\`\``;
}

export function promptReview(ctx: PromptContext): string {
  const { ledger } = ctx;
  return `DEBUG emulation — CODE REVIEW phase.

Review the bug fix in repo ${ledger.repoPath} for:
- correctness
- minimal diff
- edge cases
- missing tests

Return review comments as JSON:
\`\`\`json
{"comments":[{"id":"C1","text":"...","addressed":false}]}
\`\`\`

If no issues: {"comments":[]}`;
}

export function promptApplyReview(ctx: PromptContext): string {
  const { ledger } = ctx;
  const comments = ledger.reviewComments
    .filter((c) => !c.addressed)
    .map((c) => `- ${c.id}: ${c.text}`)
    .join("\n");

  return `DEBUG emulation — APPLY REVIEW FIXES.

Address these review comments with minimal edits:
${comments || "(none)"}

Mark each addressed. Reply:
\`\`\`json
{"addressed":["C1"]}
\`\`\``;
}

export function promptSummarize(ctx: PromptContext): string {
  const { ledger } = ctx;
  return `DEBUG emulation — FINAL SUMMARY.

Produce a structured report for run ${ledger.runId}.

Hypotheses considered:
${hypothesesBlock(ledger.hypotheses)}

Return ONLY valid JSON matching:
${SUMMARY_JSON_SCHEMA}`;
}

export function getPromptForPhase(
  phase: string,
  ctx: PromptContext,
): string {
  switch (phase) {
    case "hypothesize":
      return promptHypothesize(ctx);
    case "instrument":
      return promptInstrument(ctx);
    case "reproduce":
      return promptReproduce(ctx);
    case "analyze":
      return promptAnalyze(ctx);
    case "apply_fix":
      return promptApplyFix(ctx);
    case "verify":
      return promptVerify(ctx);
    case "mark_fixed":
      return promptMarkFixed(ctx);
    case "review":
      return promptReview(ctx);
    case "apply_review":
      return promptApplyReview(ctx);
    case "re_verify":
      return promptVerify(ctx);
    case "summarize":
      return promptSummarize(ctx);
    default:
      return `Continue debug run ${ctx.ledger.runId} phase ${phase}.`;
  }
}

/** Extract JSON from markdown fenced block or raw object in agent text. */
export function extractJsonFromText<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1]?.trim() ?? text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
