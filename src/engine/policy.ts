import type { StepRunContext, GateId } from "./catalog.js";
import type { VerifyResult } from "./step-schemas.js";

export const DONE = "done" as const;

/** Context for transition decisions: the step context plus its parsed result. */
export interface TransitionContext extends StepRunContext {
  /** Validated data from the step that just ran (null when unparsable). */
  lastData: unknown;
}

export type NextStep = string | typeof DONE;

export interface StepBudgets {
  /** Verify→analyze fix cycles (today's --max-cycles). */
  maxCycles: number;
  /** Re-verify loops in the review stage. */
  maxReviewCycles: number;
  /** Absolute executed-step cap for a run. */
  maxTotalSteps: number;
  /** Cap on orchestrator-inserted steps. */
  maxInsertedSteps: number;
  /** Default per-step retry cap (steps may override, e.g. mark_fixed). */
  maxAttemptsPerStep: number;
}

export const DEFAULT_BUDGETS: Omit<StepBudgets, "maxCycles"> = {
  maxReviewCycles: 3,
  maxTotalSteps: 30,
  maxInsertedSteps: 4,
  maxAttemptsPerStep: 2,
};

export interface StepPolicy {
  entryStep: string;
  /**
   * Deterministic transition per step — encodes the historical switch exactly.
   * Static mode follows these verbatim; guided mode uses them as the default.
   */
  defaultNext: Record<string, (ctx: TransitionContext) => NextStep>;
  /** Menu of transitions an orchestrator may legally pick per step. */
  allowedNext: Record<string, NextStep[]>;
  /** Steps an orchestrator may insert out-of-band. */
  insertable: string[];
  /** Gates that must hold before entering a step (engine-enforced). */
  gatesBefore: Record<string, GateId[]>;
  budgets: StepBudgets;
}

function verified(ctx: TransitionContext): boolean {
  return (ctx.lastData as VerifyResult | null)?.verified === true;
}

/**
 * The historical debug-loop transitions (DebugLoopController.runPhaseLoop's
 * switch), expressed as data. Any change here is a behavior change.
 */
export function buildStepPolicy(options: {
  maxCycles: number;
  budgets?: Partial<Omit<StepBudgets, "maxCycles">>;
}): StepPolicy {
  return {
    entryStep: "hypothesize",
    defaultNext: {
      hypothesize: () => "instrument",
      instrument: () => "reproduce",
      reproduce: () => "analyze",
      analyze: () => "apply_fix",
      apply_fix: () => "verify",
      verify: (ctx) => {
        const ok = verified(ctx);
        if (ok || ctx.ledger.cycles >= ctx.maxCycles) {
          if (!ok && ctx.ledger.cycles >= ctx.maxCycles) {
            ctx.ledger.status = "partial";
          }
          ctx.state.markFixedNext = "review";
          ctx.state.markFixedRetries = 0;
          return "mark_fixed";
        }
        return "analyze";
      },
      mark_fixed: (ctx) => {
        if (ctx.ledger.sentinelCountAfter > 0 && ctx.state.markFixedRetries < 2) {
          ctx.state.markFixedRetries += 1;
          ctx.log(
            `mark_fixed: ${ctx.ledger.sentinelCountAfter} sentinel(s) remain, retry ${ctx.state.markFixedRetries}`,
          );
          ctx.warn(
            `Instrumentation cleanup incomplete (${ctx.ledger.sentinelCountAfter} sentinel(s) left) — retrying mark_fixed.`,
          );
          return "mark_fixed";
        }
        if (ctx.ledger.sentinelCountAfter > 0) {
          ctx.warn(
            `Warning: ${ctx.ledger.sentinelCountAfter} DEBUG-INSTRUMENT sentinel(s) still in repo after mark_fixed.`,
          );
        }
        ctx.state.markFixedRetries = 0;
        return ctx.state.markFixedNext;
      },
      review: (ctx) =>
        ctx.ledger.reviewComments.length > 0 ? "apply_review" : "re_verify",
      apply_review: () => "re_verify",
      re_verify: (ctx) => {
        if (!verified(ctx) && ctx.ledger.reviewComments.some((c) => !c.addressed)) {
          return "apply_review";
        }
        ctx.state.markFixedNext = "summarize";
        ctx.state.markFixedRetries = 0;
        return ctx.remainingSentinels() > 0 ? "mark_fixed" : "summarize";
      },
      summarize: (ctx) => {
        ctx.ledger.status =
          ctx.ledger.status === "partial" ? "partial" : "fixed";
        return DONE;
      },
    },
    allowedNext: {
      hypothesize: ["instrument", "reproduce"],
      instrument: ["reproduce"],
      reproduce: ["analyze", "instrument"],
      analyze: ["apply_fix", "reproduce", "instrument"],
      apply_fix: ["verify"],
      verify: ["analyze", "mark_fixed", "reproduce"],
      mark_fixed: ["mark_fixed", "review", "summarize"],
      review: ["apply_review", "re_verify"],
      apply_review: ["re_verify"],
      re_verify: ["apply_review", "mark_fixed", "summarize"],
      summarize: [DONE],
    },
    insertable: ["explore", "reproduce", "instrument"],
    gatesBefore: {
      // A run may only summarize once verified (or the cycle budget escape
      // already downgraded status to partial) and with instrumentation clean.
      summarize: ["clean"],
    },
    budgets: {
      maxCycles: options.maxCycles,
      ...DEFAULT_BUDGETS,
      ...options.budgets,
    },
  };
}
