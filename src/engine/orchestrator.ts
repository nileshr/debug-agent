import { z } from "zod";
import type { Autonomy } from "../config/types.js";
import type { RunLedger, UserQuestion } from "../debug/types.js";
import type { AgentRuntime, StepPromptResult } from "../runtime/types.js";
import type { StepDefinition } from "./catalog.js";
import { DONE, type StepPolicy, type TransitionContext } from "./policy.js";
import { renderPromptTemplate, resolveTemplateFile } from "../debug/prompt-loader.js";

export type OrchestratorDecision =
  | { action: "advance"; nextStepId: string; rationale: string }
  | { action: "retry"; rationale: string; promptAddendum?: string }
  | { action: "insert"; stepId: string; rationale: string }
  | { action: "skip_to"; nextStepId: string; rationale: string }
  | { action: "ask_user"; questions: UserQuestion[]; rationale: string }
  | { action: "abort"; rationale: string }
  | { action: "done"; rationale: string };

/** Lenient schema for LLM-produced decisions; guardrails do the real vetting. */
export const OrchestratorDecisionSchema = z
  .object({
    action: z.enum(["advance", "retry", "insert", "skip_to", "ask_user", "abort"]),
    nextStepId: z.string().optional(),
    stepId: z.string().optional(),
    rationale: z.string().default(""),
    promptAddendum: z.string().optional(),
    questions: z
      .array(
        z.union([
          z.string(),
          z.object({ id: z.string().optional(), question: z.string() }),
        ]),
      )
      .optional(),
  })
  .passthrough();

export type RawLlmDecision = z.infer<typeof OrchestratorDecisionSchema>;

export interface OrchestratorInput {
  stepJustRan: StepDefinition;
  attempt: number;
  result: StepPromptResult;
  ctx: TransitionContext;
  insertedCount: number;
  totalSteps: number;
}

export interface OrchestratorOutcome {
  decision: OrchestratorDecision;
  decidedBy: "heuristic" | "llm";
  modelId?: string;
  latencyMs?: number;
}

export interface OrchestratorOptions {
  autonomy: Autonomy;
  policy: StepPolicy;
  runtime: AgentRuntime;
  /** Concrete model for LLM decisions; unset = heuristics only. */
  orchestratorModel?: string;
  repoPath: string;
  onWarn?: (message: string) => void;
}

function normalizeLlmDecision(raw: RawLlmDecision): OrchestratorDecision {
  const rationale = raw.rationale || "(no rationale given)";
  switch (raw.action) {
    case "advance":
      return { action: "advance", nextStepId: raw.nextStepId ?? "", rationale };
    case "skip_to":
      return { action: "skip_to", nextStepId: raw.nextStepId ?? "", rationale };
    case "retry":
      return { action: "retry", rationale, promptAddendum: raw.promptAddendum };
    case "insert":
      return { action: "insert", stepId: raw.stepId ?? "", rationale };
    case "abort":
      return { action: "abort", rationale };
    case "ask_user": {
      const questions: UserQuestion[] = (raw.questions ?? []).map((q, i) =>
        typeof q === "string"
          ? { id: `Q${i + 1}`, question: q }
          : { id: q.id ?? `Q${i + 1}`, question: q.question },
      );
      return { action: "ask_user", questions, rationale };
    }
  }
}

const FALLBACK_ORCHESTRATE_TEMPLATE = `You are the orchestrator of an automated debugging loop. A step just finished; choose the next loop action.

Step just ran: {{stepJustRan}} (attempt {{attempt}})
Step result parse: {{lastResultSource}}
Result digest: {{lastResultDigest}}

Run state:
{{ledgerDigest}}

Budgets remaining:
{{budgetsBlock}}

Legal actions: {{legalActions}}
Legal next steps (advance/skip_to): {{legalNextSteps}}
Insertable steps: {{insertableSteps}}

Reply with ONLY one JSON object:
{"action":"advance|retry|insert|skip_to|ask_user|abort","nextStepId":"...","stepId":"...","rationale":"...","promptAddendum":"...","questions":["..."]}`;

export class Orchestrator {
  constructor(private readonly options: OrchestratorOptions) {}

  /** Deterministic hinge detection: when the fast-path is NOT safe. */
  private isAmbiguous(input: OrchestratorInput): boolean {
    const { stepJustRan, result, ctx, attempt } = input;
    if (stepJustRan.resultSchema && result.dataSource === "none") return true;
    if (attempt > 1) return true;
    if (
      (stepJustRan.id === "verify" || stepJustRan.id === "re_verify") &&
      (result.data as { verified?: boolean } | null)?.verified !== true
    ) {
      return true;
    }
    if (stepJustRan.id === "analyze" && !ctx.ledger.confirmedHypothesisId) {
      return true;
    }
    return false;
  }

  /** Deterministic decision rules used by guided mode and as LLM fallback. */
  decideHeuristic(input: OrchestratorInput): OrchestratorDecision {
    const { stepJustRan, result, ctx, attempt, insertedCount } = input;
    const budgets = this.options.policy.budgets;

    // Unparsable result: ask the agent to re-emit its structured reply once.
    if (
      stepJustRan.resultSchema &&
      result.dataSource === "none" &&
      attempt < budgets.maxAttemptsPerStep
    ) {
      return {
        action: "retry",
        rationale:
          "The step reply did not contain the required JSON result block.",
        promptAddendum:
          "IMPORTANT: Your previous reply was missing the required fenced ```json result block. Redo this step's final output and END your reply with exactly one fenced JSON block matching the requested schema.",
      };
    }

    // Inconclusive analysis: explore once, then escalate to the user.
    if (stepJustRan.id === "analyze" && !ctx.ledger.confirmedHypothesisId) {
      if (
        insertedCount < budgets.maxInsertedSteps &&
        this.options.policy.insertable.includes("explore") &&
        !ctx.ledger.stepHistory?.some((s) => s.stepId === "explore")
      ) {
        return {
          action: "insert",
          stepId: "explore",
          rationale:
            "Analysis did not confirm a hypothesis; inserting a read-only exploration step to gather more evidence.",
        };
      }
      return {
        action: "ask_user",
        questions: [
          {
            id: "Q1",
            question:
              "The analysis could not confirm a root cause. Can you describe the exact symptom and when it started?",
          },
          {
            id: "Q2",
            question:
              "What are the precise steps (commands or clicks) that reproduce the bug?",
          },
        ],
        rationale:
          "Analysis remains inconclusive after exploration; user input is needed to proceed confidently.",
      };
    }

    // Review loop budget (dynamic modes only reach this path).
    if (
      stepJustRan.id === "re_verify" &&
      (ctx.ledger.reviewCycles ?? 0) >= budgets.maxReviewCycles &&
      (result.data as { verified?: boolean } | null)?.verified !== true
    ) {
      ctx.ledger.status = "partial";
      ctx.state.markFixedNext = "summarize";
      return {
        action: "skip_to",
        nextStepId: ctx.remainingSentinels() > 0 ? "mark_fixed" : "summarize",
        rationale: `Review loop budget exhausted (${budgets.maxReviewCycles} re-verify cycles); finishing as partial.`,
      };
    }

    // Default: follow the static transition.
    const next = this.options.policy.defaultNext[stepJustRan.id](ctx);
    if (next === DONE) {
      return { action: "done", rationale: "Static policy: run complete." };
    }
    if (next === stepJustRan.id) {
      return { action: "retry", rationale: "Static policy: repeat this step." };
    }
    return {
      action: "advance",
      nextStepId: next,
      rationale: "Static policy transition (fast path).",
    };
  }

  private buildLlmPrompt(input: OrchestratorInput): string {
    const { ctx, stepJustRan, result } = input;
    const ledger: RunLedger = ctx.ledger;
    const budgets = this.options.policy.budgets;
    const legalNext = this.options.policy.allowedNext[stepJustRan.id] ?? [];
    const digestLines = [
      `bug: ${ledger.bugDescription}`,
      `hypotheses: ${ledger.hypotheses.map((h) => `${h.id}[${h.status}]`).join(", ") || "(none)"}`,
      `confirmedHypothesis: ${ledger.confirmedHypothesisId ?? "(none)"}`,
      `fixProposed: ${ledger.fixProposed ? "yes" : "no"}`,
      `verify cycles: ${ledger.cycles}, review cycles: ${ledger.reviewCycles ?? 0}`,
      `sentinels remaining: ${ctx.remainingSentinels()}`,
      `unaddressed review comments: ${ledger.reviewComments.filter((c) => !c.addressed).length}`,
      `status: ${ledger.status}`,
    ];
    const vars = {
      stepJustRan: stepJustRan.id,
      attempt: String(input.attempt),
      lastResultSource: result.dataSource,
      lastResultDigest: JSON.stringify(result.data ?? {}).slice(0, 1500),
      ledgerDigest: digestLines.join("\n"),
      budgetsBlock: [
        `fix cycles: ${budgets.maxCycles - ledger.cycles} of ${budgets.maxCycles}`,
        `total steps: ${budgets.maxTotalSteps - input.totalSteps} of ${budgets.maxTotalSteps}`,
        `inserts: ${budgets.maxInsertedSteps - input.insertedCount} of ${budgets.maxInsertedSteps}`,
      ].join("\n"),
      legalActions: "advance, retry, insert, skip_to, ask_user, abort",
      legalNextSteps: legalNext.join(", "),
      insertableSteps: this.options.policy.insertable.join(", "),
    };
    const resolved = resolveTemplateFile("orchestrate", this.options.repoPath);
    return renderPromptTemplate(
      resolved?.text ?? FALLBACK_ORCHESTRATE_TEMPLATE,
      vars,
    ).trim();
  }

  private async decideLlm(
    input: OrchestratorInput,
  ): Promise<OrchestratorOutcome | null> {
    const model = this.options.orchestratorModel;
    if (!model) return null;
    if (!this.options.runtime.capabilities().oneShot) {
      this.options.onWarn?.(
        "Runtime does not support one-shot orchestrator calls; using heuristics.",
      );
      return null;
    }
    const prompt = this.buildLlmPrompt(input);
    const startedAt = Date.now();
    try {
      const raw = await this.options.runtime.oneShot(
        prompt,
        OrchestratorDecisionSchema,
        { model },
      );
      if (!raw) return null;
      return {
        decision: normalizeLlmDecision(raw),
        decidedBy: "llm",
        modelId: model,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      this.options.onWarn?.(
        `Orchestrator LLM call failed (${(err as Error).message}); using heuristics.`,
      );
      return null;
    }
  }

  async decide(input: OrchestratorInput): Promise<OrchestratorOutcome> {
    const ambiguous = this.isAmbiguous(input);

    if (this.options.autonomy === "guided" && !ambiguous) {
      return { decision: this.decideHeuristic(input), decidedBy: "heuristic" };
    }

    if (this.options.autonomy === "autonomous" || ambiguous) {
      const llm = await this.decideLlm(input);
      if (llm) return llm;
    }

    return { decision: this.decideHeuristic(input), decidedBy: "heuristic" };
  }
}
