import type { z } from "zod";
import type { RunLedger } from "../debug/types.js";
import type { ModelRole, StepMode } from "../runtime/types.js";
import { countSentinels, readDebugLogSince, waitForDebugLog } from "../debug/log-tail.js";
import type { PromptContext } from "../debug/prompts.js";
import {
  AnalyzeResultSchema,
  ApplyReviewResultSchema,
  ExploreResultSchema,
  HypothesizeResultSchema,
  InstrumentResultSchema,
  MarkFixedResultSchema,
  ReproduceResultSchema,
  ReviewResultSchema,
  SummarizeResultSchema,
  VerifyResultSchema,
  type AnalyzeResult,
  type ApplyReviewResult,
  type ExploreResult,
  type HypothesizeResult,
  type InstrumentResult,
  type MarkFixedResult,
  type ReproduceResult,
  type ReviewResult,
  type SummarizeResult,
} from "./step-schemas.js";

/** Gates a step can satisfy; enforced before gated steps by the engine. */
export type GateId = "verified" | "clean";

/** Mutable per-run engine scratch shared between steps and transitions. */
export interface EngineScratch {
  /** Where to go after mark_fixed succeeds (review vs summarize). */
  markFixedNext: string;
  markFixedRetries: number;
  /** Timestamp baseline for reading the instrumentation log. */
  logSinceTs: number;
}

/** Context passed to step hooks and transition functions. */
export interface StepRunContext {
  ledger: RunLedger;
  maxCycles: number;
  state: EngineScratch;
  remainingSentinels(): number;
  log(line: string): void;
  warn(message: string): void;
}

export interface StepDefinition<Out = unknown> {
  id: string;
  title: string;
  /** Prompt template stem (<id>.md unless overridden). */
  promptTemplate: string;
  mode: StepMode;
  modelRole: ModelRole;
  /** Exit contract; validated by the runtime adapter. */
  resultSchema?: z.ZodType<Out>;
  /**
   * Redirect executed before the step runs (without prompting); returning a
   * step id diverts the loop there first (e.g. summarize's sentinel check).
   */
  redirectBefore?: (ctx: StepRunContext) => string | null;
  beforePrompt?: (ctx: StepRunContext) => Promise<void> | void;
  afterPrompt?: (ctx: StepRunContext) => Promise<void> | void;
  /** Extra prompt-template variables for this execution. */
  promptExtras?: (
    ctx: StepRunContext,
  ) => Pick<PromptContext, "sentinelCountRemaining" | "markFixedRetryAttempt">;
  /** Write the validated result into the ledger (replaces parsePhaseResult). */
  applyResult?: (ledger: RunLedger, data: Out | null, ctx: StepRunContext) => void;
  costHint: "cheap" | "moderate" | "expensive";
  satisfies?: GateId[];
}

function applyHypothesize(
  ledger: RunLedger,
  data: HypothesizeResult | null,
): void {
  if (data?.hypotheses?.length) {
    ledger.hypotheses = data.hypotheses;
  } else if (ledger.todos.length) {
    ledger.hypotheses = ledger.todos.map((t, i) => ({
      id: t.id,
      rank: i + 1,
      statement: t.content,
      status: "pending" as const,
    }));
  }
}

function applyAnalyze(ledger: RunLedger, data: AnalyzeResult | null): void {
  if (data?.confirmedHypothesis) {
    ledger.confirmedHypothesisId = data.confirmedHypothesis;
    const h = ledger.hypotheses.find((x) => x.id === data.confirmedHypothesis);
    if (h) h.status = "confirmed";
  }
  if (data?.fixProposal) ledger.fixProposed = data.fixProposal;
}

function applyReviewResult(ledger: RunLedger, data: ReviewResult | null): void {
  if (data?.comments) {
    ledger.reviewComments = data.comments.map((c) => ({
      id: c.id,
      text: c.text,
      addressed: c.addressed ?? false,
    }));
  }
}

function applyApplyReview(
  ledger: RunLedger,
  data: ApplyReviewResult | null,
): void {
  if (data?.addressed?.length) {
    for (const id of data.addressed) {
      const comment = ledger.reviewComments.find((c) => c.id === id);
      if (comment) comment.addressed = true;
    }
  }
}

/** Built-in step catalog: today's fixed phases, declaratively. */
export function buildStepCatalog(): Map<string, StepDefinition> {
  const steps: StepDefinition[] = [
    {
      id: "hypothesize",
      title: "Form ranked hypotheses",
      promptTemplate: "hypothesize",
      mode: "plan",
      modelRole: "planner",
      resultSchema: HypothesizeResultSchema,
      applyResult: (ledger, data) =>
        applyHypothesize(ledger, data as HypothesizeResult | null),
      costHint: "moderate",
    },
    {
      id: "instrument",
      title: "Add debug instrumentation",
      promptTemplate: "instrument",
      mode: "execute",
      modelRole: "fixer",
      resultSchema: InstrumentResultSchema,
      beforePrompt: (ctx) => {
        ctx.ledger.sentinelCountBefore = countSentinels(
          ctx.ledger.repoPath,
          ctx.ledger.runId,
        );
      },
      applyResult: (ledger, data) => {
        const d = data as InstrumentResult | null;
        if (d?.filesTouched) ledger.filesTouched = d.filesTouched;
      },
      costHint: "moderate",
    },
    {
      id: "reproduce",
      title: "Reproduce the bug",
      promptTemplate: "reproduce",
      mode: "execute",
      modelRole: "fixer",
      resultSchema: ReproduceResultSchema,
      beforePrompt: (ctx) => {
        ctx.state.logSinceTs = Date.now();
      },
      afterPrompt: async (ctx) => {
        if (ctx.ledger.verifyMode === "browser") {
          ctx.ledger.logEntries = await waitForDebugLog({
            repoPath: ctx.ledger.repoPath,
            sinceTs: ctx.state.logSinceTs - 60_000,
            minEntries: 1,
            timeoutMs: 90_000,
          });
        } else {
          ctx.ledger.logEntries = readDebugLogSince(
            ctx.ledger.repoPath,
            ctx.state.logSinceTs - 60_000,
          );
        }
      },
      applyResult: (ledger, data) => {
        const d = data as ReproduceResult | null;
        if (d?.steps) ledger.reproductionSteps = d.steps;
      },
      costHint: "expensive",
    },
    {
      id: "analyze",
      title: "Analyze captured evidence",
      promptTemplate: "analyze",
      mode: "execute",
      modelRole: "fixer",
      resultSchema: AnalyzeResultSchema,
      applyResult: (ledger, data, ctx) => {
        applyAnalyze(ledger, data as AnalyzeResult | null);
        void ctx;
      },
      costHint: "moderate",
    },
    {
      id: "apply_fix",
      title: "Apply the fix",
      promptTemplate: "apply_fix",
      mode: "execute",
      modelRole: "fixer",
      costHint: "moderate",
    },
    {
      id: "verify",
      title: "Verify the fix",
      promptTemplate: "verify",
      mode: "execute",
      modelRole: "fixer",
      resultSchema: VerifyResultSchema,
      beforePrompt: (ctx) => {
        ctx.ledger.cycles += 1;
      },
      satisfies: ["verified"],
      costHint: "expensive",
    },
    {
      id: "mark_fixed",
      title: "Remove instrumentation",
      promptTemplate: "mark_fixed",
      mode: "execute",
      modelRole: "fixer",
      resultSchema: MarkFixedResultSchema,
      promptExtras: (ctx) => ({
        sentinelCountRemaining: ctx.remainingSentinels(),
        markFixedRetryAttempt: ctx.state.markFixedRetries,
      }),
      afterPrompt: (ctx) => {
        ctx.ledger.sentinelCountAfter = ctx.remainingSentinels();
      },
      applyResult: (ledger, data, ctx) => {
        const d = data as MarkFixedResult | null;
        if (d?.cleaned === false) {
          ctx.log("mark_fixed: agent reported cleaned=false");
        }
        void ledger;
      },
      satisfies: ["clean"],
      costHint: "cheap",
    },
    {
      id: "review",
      title: "Review the change",
      promptTemplate: "review",
      mode: "execute",
      modelRole: "reviewer",
      resultSchema: ReviewResultSchema,
      applyResult: (ledger, data) =>
        applyReviewResult(ledger, data as ReviewResult | null),
      costHint: "moderate",
    },
    {
      id: "apply_review",
      title: "Address review comments",
      promptTemplate: "apply_review",
      mode: "execute",
      modelRole: "fixer",
      resultSchema: ApplyReviewResultSchema,
      applyResult: (ledger, data) =>
        applyApplyReview(ledger, data as ApplyReviewResult | null),
      costHint: "moderate",
    },
    {
      id: "re_verify",
      title: "Re-verify after review",
      promptTemplate: "re_verify",
      mode: "execute",
      modelRole: "fixer",
      resultSchema: VerifyResultSchema,
      beforePrompt: (ctx) => {
        ctx.ledger.reviewCycles = (ctx.ledger.reviewCycles ?? 0) + 1;
      },
      satisfies: ["verified"],
      costHint: "expensive",
    },
    {
      // Not on the nominal path — inserted by the orchestrator when analysis
      // is inconclusive (read-only investigation).
      id: "explore",
      title: "Explore the codebase for more evidence",
      promptTemplate: "explore",
      mode: "plan",
      modelRole: "fixer",
      resultSchema: ExploreResultSchema,
      applyResult: (ledger, data) => {
        const d = data as ExploreResult | null;
        if (d?.findings?.length) {
          ledger.exploreFindings = [
            ...(ledger.exploreFindings ?? []),
            ...d.findings,
          ];
        }
      },
      costHint: "moderate",
    },
    {
      id: "summarize",
      title: "Summarize the run",
      promptTemplate: "summarize",
      mode: "execute",
      modelRole: "fixer",
      resultSchema: SummarizeResultSchema,
      redirectBefore: (ctx) => {
        if (ctx.remainingSentinels() > 0) {
          ctx.state.markFixedNext = "summarize";
          ctx.state.markFixedRetries = 0;
          ctx.warn(
            "Instrumentation still present before summarize — running mark_fixed cleanup.",
          );
          return "mark_fixed";
        }
        return null;
      },
      applyResult: (ledger, data) => {
        const d = data as SummarizeResult | null;
        if (d) ledger.summary = d;
      },
      costHint: "cheap",
    },
  ];

  return new Map(steps.map((s) => [s.id, s]));
}

/** Ordered nominal path (excludes the dynamic-only re_verify detours). */
export function catalogStepIds(catalog: Map<string, StepDefinition>): string[] {
  return [...catalog.keys()];
}
