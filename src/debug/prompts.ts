import type { Hypothesis, Phase, RunLedger } from "./types.js";
import { browserMcpLabel } from "../mcp/browser.js";
import { debugLogPath } from "./repo-paths.js";
import { readPackageScripts } from "./verify-target.js";
import {
  renderPromptTemplate,
  resolvePromptTemplate,
} from "./prompt-loader.js";

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
  /** Remaining DEBUG-INSTRUMENT sentinels (mark_fixed phase). */
  sentinelCountRemaining?: number;
  /** 0 = first cleanup attempt; >0 = controller retry after incomplete cleanup. */
  markFixedRetryAttempt?: number;
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

function verificationBlock(ledger: RunLedger): string {
  if (ledger.verifyMode === "browser") {
    const mcp = browserMcpLabel(ledger.browserMcp ?? "playwright");
    return `Verification: browser (${mcp})\nApp URL: ${ledger.url ?? "(not set)"}`;
  }
  const scripts = readPackageScripts(ledger.repoPath);
  const scriptLines = scripts
    ? Object.entries(scripts)
        .map(([name, cmd]) => `  ${name}: ${cmd}`)
        .join("\n")
    : "  (no package.json scripts — infer commands from the repo)";
  return `Verification: CLI (shell — do NOT use browser MCP)
Use terminal/shell tools to reproduce and verify. Prefer npm/bun scripts from package.json:
${scriptLines}`;
}

function reproduceBodyCli(ledger: RunLedger): string {
  return `DEBUG emulation — REPRODUCE phase.

${verificationBlock(ledger)}

Bug: ${ledger.bugDescription}

Steps:
1. Run the CLI command(s) that trigger the bug (build, test, or direct bin invocation).
2. Capture stdout/stderr and exit codes.
3. If instrumentation was added, check ${debugLogPath(ledger.repoPath)} for runtime data.

When done, reply with:
\`\`\`json
{"steps":["npm run build","node dist/cli.js -V"],"logCaptured":true}
\`\`\``;
}

function reproduceBodyBrowser(ledger: RunLedger): string {
  const mcp = browserMcpLabel(ledger.browserMcp ?? "playwright");
  return `DEBUG emulation — REPRODUCE phase.

Use ${mcp} to reproduce the bug.

URL: ${ledger.url}
Bug: ${ledger.bugDescription}

Steps:
1. Open the URL in the browser via ${mcp}.
2. Perform actions that trigger the bug.
3. Confirm runtime data was written to ${debugLogPath(ledger.repoPath)}

When done, reply with:
\`\`\`json
{"steps":["step 1","step 2"],"logCaptured":true}
\`\`\``;
}

function verifyBodyCli(ledger: RunLedger): string {
  return `DEBUG emulation — VERIFY phase.

${verificationBlock(ledger)}

Re-run the same CLI command(s) used to reproduce the bug. The fix should prevent the original failure.

IMPORTANT: Do NOT remove debug instrumentation in this phase. Keep every line containing // DEBUG-INSTRUMENT:${ledger.runId} and keep ${debugLogPath(ledger.repoPath)} logging in place. Cleanup happens in a later mark_fixed phase.

If verification passes:
\`\`\`json
{"verified":true}
\`\`\`

If it still fails:
\`\`\`json
{"verified":false,"reason":"..."}
\`\`\``;
}

function verifyBodyBrowser(ledger: RunLedger): string {
  const mcp = browserMcpLabel(ledger.browserMcp ?? "playwright");
  return `DEBUG emulation — VERIFY phase.

Reproduce the bug scenario using ${mcp} at ${ledger.url}.
The fix should prevent the original failure.

IMPORTANT: Do NOT remove debug instrumentation in this phase. Keep every line containing // DEBUG-INSTRUMENT:${ledger.runId} and keep ${debugLogPath(ledger.repoPath)} logging in place. Cleanup happens in a later mark_fixed phase.

If verification passes:
\`\`\`json
{"verified":true}
\`\`\`

If it still fails:
\`\`\`json
{"verified":false,"reason":"..."}
\`\`\``;
}

function buildPromptVars(_phase: Phase, ctx: PromptContext): Record<string, string> {
  const { ledger, logSnippet, sinceTs } = ctx;
  const logPath = debugLogPath(ledger.repoPath);
  const reviewCommentsBlock =
    ledger.reviewComments
      .filter((c) => !c.addressed)
      .map((c) => `- ${c.id}: ${c.text}`)
      .join("\n") || "(none)";

  return {
    bugDescription: ledger.bugDescription,
    repoPath: ledger.repoPath,
    runId: ledger.runId,
    verificationBlock: verificationBlock(ledger),
    hypothesesBlock: hypothesesBlock(ledger.hypotheses),
    debugLogPath: logPath,
    logSnippet: logSnippet ?? "(read the file)",
    sinceTs: String(sinceTs ?? 0),
    confirmedHypothesisId: ledger.confirmedHypothesisId ?? "see analysis",
    fixProposal: ledger.fixProposed ?? "see prior analysis",
    reviewCommentsBlock,
    summaryJsonSchema: SUMMARY_JSON_SCHEMA,
    reproduceBody:
      ledger.verifyMode === "cli"
        ? reproduceBodyCli(ledger)
        : reproduceBodyBrowser(ledger),
    verifyBody:
      ledger.verifyMode === "cli"
        ? verifyBodyCli(ledger)
        : verifyBodyBrowser(ledger),
    sentinelCountRemaining: String(ctx.sentinelCountRemaining ?? 0),
    cleanupRetryNote:
      (ctx.markFixedRetryAttempt ?? 0) > 0
        ? `RETRY ${ctx.markFixedRetryAttempt}: Previous cleanup left ${ctx.sentinelCountRemaining ?? "?"} sentinel(s). Search the repo for // DEBUG-INSTRUMENT:${ledger.runId} and remove ALL matches plus debug-only log writes.`
        : "",
  };
}

/** Built-in fallback when no template file is found. */
function fallbackPrompt(phase: Phase, ctx: PromptContext): string {
  const vars = buildPromptVars(phase, ctx);
  switch (phase) {
    case "hypothesize":
      return renderPromptTemplate(
        `You are in DEBUG emulation — HYPOTHESIZE phase.\n\nBug description:\n{{bugDescription}}\n\n{{verificationBlock}}\nRepo: {{repoPath}}\nRun ID: {{runId}}`,
        vars,
      );
    case "instrument":
      return renderPromptTemplate(
        `DEBUG emulation — INSTRUMENT phase.\n\nRun ID: {{runId}}\nHypotheses:\n{{hypothesesBlock}}\n\nAdd logging to {{debugLogPath}}`,
        vars,
      );
    case "reproduce":
      return vars.reproduceBody;
    case "analyze":
      return renderPromptTemplate(
        `DEBUG emulation — ANALYZE phase.\n\nHypotheses:\n{{hypothesesBlock}}\n\nLog: {{debugLogPath}}\n{{logSnippet}}`,
        vars,
      );
    case "apply_fix":
      return renderPromptTemplate(
        `DEBUG emulation — APPLY FIX.\nConfirmed: {{confirmedHypothesisId}}\nProposal: {{fixProposal}}`,
        vars,
      );
    case "verify":
    case "re_verify":
      return vars.verifyBody;
    case "mark_fixed":
      return renderPromptTemplate(
        `Remove instrumentation // DEBUG-INSTRUMENT:{{runId}} from repo.`,
        vars,
      );
    case "review":
      return renderPromptTemplate(
        `DEBUG emulation — CODE REVIEW for {{repoPath}}.`,
        vars,
      );
    case "apply_review":
      return renderPromptTemplate(
        `Address review:\n{{reviewCommentsBlock}}`,
        vars,
      );
    case "summarize":
      return renderPromptTemplate(
        `FINAL SUMMARY run {{runId}}\n{{hypothesesBlock}}\nSchema: {{summaryJsonSchema}}`,
        vars,
      );
    default:
      return `Continue debug run ${ctx.ledger.runId} phase ${phase}.`;
  }
}

export function getPromptForPhase(phase: string, ctx: PromptContext): string {
  const p = phase as Phase;
  const vars = buildPromptVars(p, ctx);
  const resolved = resolvePromptTemplate(p, ctx.ledger.repoPath);
  if (resolved) {
    return renderPromptTemplate(resolved.text, vars).trim();
  }
  return fallbackPrompt(p, ctx);
}

export { extractJsonFromText } from "../runtime/json-extract.js";
