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
import { Orchestrator } from "./orchestrator.js";
import { applyGuardrails } from "./guardrails.js";
import {
  askInteractively,
  canAskInteractively,
  userAnswersBlock,
} from "./escalation.js";
import type { Autonomy } from "../config/types.js";
import type { AgentRuntime } from "../runtime/types.js";

export interface EngineCallbacks {
  onStepStart?: (stepId: string) => void;
  onStepEnd?: (stepId: string) => void;
}

export interface LoopEngineOptions {
  ledger: RunLedger;
  session: RuntimeSession;
  agentConfig: ResolvedAgentConfig;
  maxCycles: number;
  /** static: historical fixed transitions; guided/autonomous: orchestrated. */
  autonomy?: Autonomy;
  /** Runtime handle for orchestrator one-shot decisions (guided/autonomous). */
  runtime?: AgentRuntime;
  runLog?: RunLogWriter;
  callbacks?: EngineCallbacks;
  onWarn?: (message: string) => void;
  /** TTY confirmation gate after hypothesize (today's --confirm-plan). */
  confirmPlanGate?: () => Promise<boolean>;
  catalog?: Map<string, StepDefinition>;
  policy?: StepPolicy;
}

export interface EngineRunResult {
  stoppedAfterPlan: boolean;
  /** Run paused pending user answers (ledger.pendingQuestions); exit code 3. */
  waitingOnUser?: boolean;
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
    extras?: Pick<DecisionRecord, "overridden" | "modelId" | "latencyMs">,
  ): DecisionRecord {
    const decision: DecisionRecord = {
      seq: (this.opts.ledger.decisions?.length ?? 0) + 1,
      ts: Date.now(),
      afterStep,
      decidedBy,
      action,
      nextStepId,
      rationale,
      ...extras,
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
    const autonomy: Autonomy = this.opts.autonomy ?? "static";
    const orchestrator =
      autonomy !== "static" && this.opts.runtime
        ? new Orchestrator({
            autonomy,
            policy: this.policy,
            runtime: this.opts.runtime,
            orchestratorModel: this.opts.agentConfig.models.orchestrator,
            repoPath: ledger.repoPath,
            onWarn: this.opts.onWarn,
          })
        : null;
    const catalogIds = new Set(this.catalog.keys());
    let current = startStepId;
    let insertReturnTo: string | null = null;
    let insertedCount = ledger.stepHistory?.filter((s) => s.inserted).length ?? 0;
    let nextIsInserted = false;
    let pendingAddendum: string | null = null;

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
        ...(nextIsInserted ? { inserted: true } : {}),
      };
      nextIsInserted = false;
      ledger.stepHistory?.push(record);

      await step.beforePrompt?.(ctx);

      let text =
        this.buildPrompt(step, ctx) + userAnswersBlock(ledger.userAnswers);
      if (pendingAddendum) {
        text += `\n\n${pendingAddendum}`;
        pendingAddendum = null;
      }
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

      const tctx: TransitionContext = { ...ctx, lastData: result.data };

      // Deterministic return after an inserted step (bounded detour).
      if (insertReturnTo) {
        const returnTo = insertReturnTo;
        insertReturnTo = null;
        this.recordDecision(
          current,
          "advance",
          returnTo,
          "Returning to the interrupted flow after the inserted step.",
          "heuristic",
        );
        store.recordPhaseComplete(
          ledger.runId,
          current as Phase,
          returnTo as Phase,
          ledger,
        );
        callbacks?.onStepEnd?.(current);
        current = returnTo;
        continue;
      }

      let next: string;

      if (!orchestrator) {
        const transition = this.policy.defaultNext[current];
        if (!transition) {
          throw new Error(`No transition defined for step: ${current}`);
        }
        next = transition(tctx);
        this.recordDecision(
          current,
          this.classifyTransition(current, next),
          next === DONE ? undefined : next,
          "Static policy transition.",
        );
      } else {
        // Hard budget: absolute step count (engine-enforced, dynamic modes).
        if ((ledger.stepHistory?.length ?? 0) >= this.policy.budgets.maxTotalSteps) {
          ledger.status = "partial";
          this.recordDecision(
            current,
            "abort",
            undefined,
            `Total step budget exhausted (${this.policy.budgets.maxTotalSteps}); finishing as partial.`,
            "guardrail_override",
          );
          store.recordPhaseComplete(ledger.runId, current as Phase, "done", ledger);
          callbacks?.onStepEnd?.(current);
          break;
        }

        const outcome = await orchestrator.decide({
          stepJustRan: step,
          attempt,
          result,
          ctx: tctx,
          insertedCount,
          totalSteps: ledger.stepHistory?.length ?? 0,
        });
        const guarded = applyGuardrails(
          {
            step,
            policy: this.policy,
            ctx: tctx,
            attempt,
            insertedCount,
            catalogIds,
          },
          outcome.decision,
        );
        const decision = guarded.decision;
        const decidedBy = guarded.overridden
          ? "guardrail_override"
          : outcome.decidedBy;
        const overriddenExtra = guarded.overridden
          ? {
              overridden: {
                action: guarded.overridden.decision.action as DecisionAction,
                nextStepId:
                  "nextStepId" in guarded.overridden.decision
                    ? guarded.overridden.decision.nextStepId
                    : "stepId" in guarded.overridden.decision
                      ? guarded.overridden.decision.stepId
                      : undefined,
                reason: guarded.overridden.reason,
              },
            }
          : {};

        switch (decision.action) {
          case "advance":
          case "skip_to":
            next = decision.nextStepId;
            break;
          case "done":
            next = DONE;
            break;
          case "retry":
            next = current;
            pendingAddendum = decision.promptAddendum ?? null;
            break;
          case "insert":
            insertReturnTo = current;
            insertedCount += 1;
            nextIsInserted = true;
            next = decision.stepId;
            break;
          case "abort":
            ledger.status = "partial";
            next = DONE;
            break;
          case "ask_user": {
            this.recordDecision(
              current,
              "ask_user",
              undefined,
              decision.rationale,
              decidedBy,
              { ...overriddenExtra, modelId: outcome.modelId, latencyMs: outcome.latencyMs },
            );
            if (canAskInteractively()) {
              const answers = await askInteractively(decision.questions);
              ledger.userAnswers = [...(ledger.userAnswers ?? []), ...answers];
              const resumed = this.policy.defaultNext[current](tctx);
              this.recordDecision(
                current,
                resumed === DONE ? "done" : "advance",
                resumed === DONE ? undefined : resumed,
                "User answered inline; continuing with the default transition.",
                "user",
              );
              store.recordPhaseComplete(
                ledger.runId,
                current as Phase,
                resumed as Phase,
                ledger,
              );
              callbacks?.onStepEnd?.(current);
              current = resumed;
              continue;
            }
            // Non-interactive: pause the run and hand off to `debug resume`.
            const resumeStep = this.policy.defaultNext[current](tctx);
            ledger.pendingQuestions = decision.questions;
            store.markWaitingOnUser(
              ledger.runId,
              ledger,
              resumeStep === DONE ? "summarize" : resumeStep,
            );
            callbacks?.onStepEnd?.(current);
            return { stoppedAfterPlan: false, waitingOnUser: true };
          }
        }

        this.recordDecision(
          current,
          decision.action === "done"
            ? "done"
            : (decision.action as DecisionAction),
          next === DONE ? undefined : next,
          decision.rationale,
          decidedBy,
          { ...overriddenExtra, modelId: outcome.modelId, latencyMs: outcome.latencyMs },
        );
      }

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
