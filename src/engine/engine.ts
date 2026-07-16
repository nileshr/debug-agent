import fs from "node:fs";
import chalk from "chalk";
import type { ResolvedAgentConfig } from "../config/types.js";
import { modelForPhase } from "../config/resolve.js";
import { countSentinels, groupByHypothesis, readDebugLogSince } from "../debug/log-tail.js";
import { debugLogPath } from "../debug/repo-paths.js";
import { getPromptForPhase } from "../debug/prompts.js";
import { getRunStore } from "../debug/run-store.js";
import type {
  DecisionAction,
  DecisionRecord,
  Phase,
  RunLedger,
  StepExecutionRecord,
} from "../debug/types.js";
import type { RuntimeSession } from "../runtime/types.js";
import type { RunLogWriter } from "../logging/run-log.js";
import {
  buildStepCatalog,
  type EngineScratch,
  type StepDefinition,
  type StepRunContext,
} from "./catalog.js";
import { buildStepPolicy, DONE, type StepPolicy, type TransitionContext } from "./policy.js";

export interface EngineCallbacks {
  onStepStart?: (stepId: string) => void;
  onStepEnd?: (stepId: string) => void;
}

export interface LoopEngineOptions {
  ledger: RunLedger;
  session: RuntimeSession;
  agentConfig: ResolvedAgentConfig;
  maxCycles: number;
  runLog?: RunLogWriter;
  callbacks?: EngineCallbacks;
  /** TTY confirmation gate after hypothesize (today's --confirm-plan). */
  confirmPlanGate?: () => Promise<boolean>;
  catalog?: Map<string, StepDefinition>;
  policy?: StepPolicy;
}

export interface EngineRunResult {
  stoppedAfterPlan: boolean;
}

/**
 * Catalog/policy-driven loop engine. In static autonomy (the only mode so
 * far) it follows StepPolicy.defaultNext verbatim, reproducing the historical
 * DebugLoopController.runPhaseLoop switch, while recording an auditable
 * step + decision history.
 */
export class LoopEngine {
  private readonly catalog: Map<string, StepDefinition>;
  private readonly policy: StepPolicy;
  private readonly opts: LoopEngineOptions;
  private readonly scratch: EngineScratch = {
    markFixedNext: "review",
    markFixedRetries: 0,
    logSinceTs: 0,
  };

  constructor(options: LoopEngineOptions) {
    this.opts = options;
    this.catalog = options.catalog ?? buildStepCatalog();
    this.policy =
      options.policy ?? buildStepPolicy({ maxCycles: options.maxCycles });
    options.ledger.stepHistory ??= [];
    options.ledger.decisions ??= [];
  }

  private stepContext(): StepRunContext {
    const { ledger, maxCycles, runLog } = this.opts;
    return {
      ledger,
      maxCycles,
      state: this.scratch,
      remainingSentinels: () => countSentinels(ledger.repoPath, ledger.runId),
      log: (line) => runLog?.line(line),
      warn: (message) => console.log(chalk.yellow(message)),
    };
  }

  private nextAttempt(stepId: string): number {
    const history = this.opts.ledger.stepHistory ?? [];
    const prev = history[history.length - 1];
    return prev && prev.stepId === stepId ? prev.attempt + 1 : 1;
  }

  private recordDecision(
    afterStep: string,
    action: DecisionAction,
    nextStepId: string | undefined,
    rationale: string,
    decidedBy: DecisionRecord["decidedBy"] = "static",
  ): DecisionRecord {
    const decision: DecisionRecord = {
      seq: (this.opts.ledger.decisions?.length ?? 0) + 1,
      ts: Date.now(),
      afterStep,
      decidedBy,
      action,
      nextStepId,
      rationale,
    };
    this.opts.ledger.decisions?.push(decision);
    getRunStore().recordDecision(this.opts.ledger.runId, decision);
    return decision;
  }

  private classifyTransition(stepId: string, next: string): DecisionAction {
    if (next === DONE) return "done";
    if (next === stepId) return "retry";
    return "advance";
  }

  private buildPrompt(step: StepDefinition, ctx: StepRunContext): string {
    const { ledger } = this.opts;
    const stored = ledger.logEntries as ReturnType<typeof readDebugLogSince>;
    const logSnippet =
      stored.length > 0
        ? JSON.stringify(groupByHypothesis(stored), null, 2)
        : fs.existsSync(debugLogPath(ledger.repoPath))
          ? fs.readFileSync(debugLogPath(ledger.repoPath), "utf8").slice(-4000)
          : undefined;

    return getPromptForPhase(step.id, {
      ledger,
      logSnippet,
      sinceTs: this.scratch.logSinceTs,
      ...(step.promptExtras?.(ctx) ?? {}),
    });
  }

  async run(startStepId: string): Promise<EngineRunResult> {
    const { ledger, callbacks, runLog, session, agentConfig } = this.opts;
    const store = getRunStore();
    let current = startStepId;

    while (current !== DONE) {
      const step = this.catalog.get(current);
      if (!step) {
        throw new Error(`Unknown step in loop: ${current}`);
      }

      ledger.phase = current as Phase;
      store.recordPhaseStart(ledger.runId, current as Phase, ledger);
      callbacks?.onStepStart?.(current);

      const ctx = this.stepContext();

      // Pre-step redirect (e.g. summarize's sentinel cleanup detour).
      const redirect = step.redirectBefore?.(ctx) ?? null;
      if (redirect) {
        const seq = store.beginStep(ledger.runId, current, this.nextAttempt(current));
        const record: StepExecutionRecord = {
          seq,
          stepId: current,
          attempt: this.nextAttempt(current),
          startedAt: Date.now(),
          endedAt: Date.now(),
          dataSource: "none",
          ok: true,
        };
        ledger.stepHistory?.push(record);
        store.completeStep(ledger.runId, seq, "skipped", null);
        this.recordDecision(
          current,
          "advance",
          redirect,
          "Redirected before prompting (precondition unmet).",
        );
        store.recordPhaseComplete(
          ledger.runId,
          current as Phase,
          redirect as Phase,
          ledger,
        );
        callbacks?.onStepEnd?.(current);
        current = redirect;
        continue;
      }

      const attempt = this.nextAttempt(current);
      const seq = store.beginStep(ledger.runId, current, attempt);
      const record: StepExecutionRecord = {
        seq,
        stepId: current,
        attempt,
        startedAt: Date.now(),
      };
      ledger.stepHistory?.push(record);

      await step.beforePrompt?.(ctx);

      const text = this.buildPrompt(step, ctx);
      runLog?.line(`prompt:${step.id} bytes=${text.length}`);

      const result = await session.prompt({
        text,
        mode: step.mode,
        model: modelForPhase(step.id as Phase, agentConfig.models),
        resultSchema: step.resultSchema,
      });

      step.applyResult?.(ledger, result.data, ctx);
      await step.afterPrompt?.(ctx);

      record.endedAt = Date.now();
      record.dataSource = result.dataSource;
      record.ok = result.stopReason === "end_turn";
      store.completeStep(ledger.runId, seq, "completed", result.dataSource);

      runLog?.line(
        `phase:${step.id} streamBytes=${ledger.streamBuffer.length}`,
      );

      // Plan-confirmation gate (interactive) — may stop the run entirely.
      if (step.id === "hypothesize" && this.opts.confirmPlanGate) {
        const ok = await this.opts.confirmPlanGate();
        if (!ok) {
          ledger.status = "partial";
          runLog?.line("User stopped after plan confirmation");
          store.markInterrupted(ledger.runId, ledger);
          this.recordDecision(
            current,
            "abort",
            undefined,
            "User stopped after plan confirmation.",
            "user",
          );
          store.recordPhaseComplete(ledger.runId, current as Phase, "done", ledger);
          callbacks?.onStepEnd?.(current);
          return { stoppedAfterPlan: true };
        }
      }

      const transition = this.policy.defaultNext[current];
      if (!transition) {
        throw new Error(`No transition defined for step: ${current}`);
      }
      const tctx: TransitionContext = { ...ctx, lastData: result.data };
      const next = transition(tctx);

      this.recordDecision(
        current,
        this.classifyTransition(current, next),
        next === DONE ? undefined : next,
        "Static policy transition.",
      );
      store.recordPhaseComplete(
        ledger.runId,
        current as Phase,
        next as Phase,
        ledger,
      );
      callbacks?.onStepEnd?.(current);
      current = next;
    }

    return { stoppedAfterPlan: false };
  }
}
