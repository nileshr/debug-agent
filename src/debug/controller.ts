import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ora, { type Ora } from "ora";
import chalk from "chalk";
import { AcpClient } from "../acp/client.js";
import type { ResolvedAgentConfig } from "../config/types.js";
import { modelForPhase } from "../config/resolve.js";
import { acpMcpServersParam, ensureBrowserMcpConfig } from "../mcp/browser.js";
import { resolveSpawnCwd } from "../util/cwd.js";
import {
  countSentinels,
  groupByHypothesis,
  readDebugLogSince,
  waitForDebugLog,
} from "./log-tail.js";
import { debugLogPath, debugRunsDir, debugRunLedgerPath } from "./repo-paths.js";
import {
  extractJsonFromText,
  getPromptForPhase,
  type PromptContext,
} from "./prompts.js";
import { buildFinalReportFromLedger } from "../report/build-report.js";
import type { VerifyMode } from "./types.js";
import {
  type FinalReport,
  type Hypothesis,
  type Phase,
  type RunLedger,
  RunSummarySchema,
} from "./types.js";
import type { CursorUpdateTodosParams } from "../acp/types.js";
import {
  AgentTraceCollector,
  LiveTraceDisplay,
} from "./trace.js";
import { getRunStore } from "./run-store.js";
import { confirmPlanAfterHypothesis } from "./plan-confirm.js";

export interface ControllerOptions {
  repoPath: string;
  verifyMode: VerifyMode;
  url?: string;
  bugDescription: string;
  agentConfig: ResolvedAgentConfig;
  maxCycles?: number;
  writeReport?: boolean;
  openReport?: boolean;
  /** Pause after hypothesize for user to review plan (TTY). */
  confirmPlan?: boolean;
  /** Resume ACP session only (session/load). */
  resumeSessionId?: string;
  /** Resume loop state from ~/.debug-agent/state.db (phase + ledger). */
  resumeRunId?: string;
  onPhase?: (phase: Phase) => void;
  /** Optional run log writer (full diagnostic log for issue reports). */
  runLog?: import("../logging/run-log.js").RunLogWriter;
}

export interface ControllerResult {
  ledger: RunLedger;
  report: FinalReport | null;
  reportPath: string | null;
}

export class DebugLoopController {
  private client: AcpClient;
  private readonly options: Required<
    Pick<ControllerOptions, "maxCycles" | "writeReport" | "openReport">
  > &
    ControllerOptions;
  private activeModel = "";
  private ledger!: RunLedger;
  private sessionId!: string;
  private spinner: Ora | null = null;
  private logSinceTs = 0;
  private readonly trace = new AgentTraceCollector();
  private readonly liveTrace = new LiveTraceDisplay(5);
  private interrupted = false;
  private stoppedAfterPlan = false;
  /** Where to go after mark_fixed succeeds (review vs summarize). */
  private markFixedNext: Phase = "review";
  private markFixedRetries = 0;

  constructor(options: ControllerOptions) {
    this.options = {
      maxCycles: options.maxCycles ?? 5,
      writeReport: options.writeReport ?? true,
      openReport: options.openReport ?? true,
      ...options,
    };
    this.activeModel = options.agentConfig.models.fixer;
    this.client = new AcpClient({
      spawnCwd: resolveSpawnCwd(options.repoPath),
      permissionPolicy: { repoPath: path.resolve(options.repoPath) },
      onStdoutChunk: (text) => {
        if (this.ledger) {
          this.ledger.streamBuffer += text;
          this.ledger.transcript.push(text);
          this.trace.appendStreamChunk(text);
          this.pushLiveTrace();
        }
      },
      onTrace: (event) => {
        if (!this.ledger) return;
        this.trace.add(event.kind, event.text);
        this.pushLiveTrace();
      },
    });
  }

  async run(): Promise<ControllerResult> {
    const repoPath = path.resolve(this.options.repoPath);
    const store = getRunStore();
    let startPhase: Phase = "hypothesize";

    if (this.options.resumeRunId) {
      const loaded = store.loadRun(this.options.resumeRunId);
      if (!loaded) {
        throw new Error(`Run not found in state DB: ${this.options.resumeRunId}`);
      }
      if (path.resolve(loaded.repoPath) !== repoPath) {
        throw new Error(
          `Run ${this.options.resumeRunId} belongs to ${loaded.repoPath}, not ${repoPath}`,
        );
      }
      if (loaded.runStatus === "completed") {
        throw new Error(
          `Run ${this.options.resumeRunId} already completed (${loaded.ledger.status})`,
        );
      }
      if (loaded.runStatus === "running") {
        throw new Error(
          `Run ${this.options.resumeRunId} is still marked running — another debug process may be active`,
        );
      }
      this.ledger = { ...loaded.ledger, status: "running", streamBuffer: "" };
      this.options.agentConfig = {
        ...this.options.agentConfig,
        models: {
          planner: this.ledger.plannerModel ?? this.ledger.model,
          fixer: this.ledger.model,
          reviewer: this.ledger.reviewer,
        },
        browserMcp:
          this.ledger.browserMcp ?? this.options.agentConfig.browserMcp,
      };
      this.activeModel = "";
      startPhase =
        loaded.nextPhase === "done" ? "summarize" : loaded.nextPhase;
      this.options.resumeSessionId =
        this.options.resumeSessionId ?? loaded.sessionId;
      this.ledger.sessionResumed = true;
      store.reopenRun(this.ledger.runId, this.ledger);
      console.log(
        chalk.dim(
          `Resuming run ${this.ledger.runId} from phase ${startPhase} (state DB)`,
        ),
      );
    } else {
      const runId = randomUUID().slice(0, 8);
      this.ledger = {
        runId,
        sessionId: "",
        sessionResumed: Boolean(this.options.resumeSessionId),
        repoPath,
        verifyMode: this.options.verifyMode,
        url: this.options.url,
        bugDescription: this.options.bugDescription,
        model: this.options.agentConfig.models.fixer,
        plannerModel: this.options.agentConfig.models.planner,
        reviewer: this.options.agentConfig.models.reviewer,
        browserMcp: this.options.agentConfig.browserMcp,
        startedAt: Date.now(),
        phase: "hypothesize",
        cycles: 0,
        reviewCycles: 0,
        hypotheses: [],
        todos: [],
        filesTouched: [],
        sentinelCountBefore: 0,
        sentinelCountAfter: 0,
        reproductionSteps: [],
        logEntries: [],
        reviewComments: [],
        trace: [],
        transcript: [],
        streamBuffer: "",
        status: "running",
      };
      store.createRun(
        {
          runId,
          repoPath,
          bugDescription: this.options.bugDescription,
          verifyMode: this.options.verifyMode,
          url: this.options.url,
          model: this.options.agentConfig.models.fixer,
          reviewer: this.options.agentConfig.models.reviewer,
          maxCycles: this.options.maxCycles,
        },
        this.ledger,
      );
    }

    fs.mkdirSync(debugRunsDir(repoPath), { recursive: true });
    if (this.options.verifyMode === "browser") {
      ensureBrowserMcpConfig(repoPath, this.options.agentConfig.browserMcp);
    }

    const onSignal = (): void => {
      this.interrupted = true;
      if (this.ledger?.status === "running") {
        getRunStore().markInterrupted(this.ledger.runId, this.ledger);
        this.persistLedger();
      }
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      await this.client.start();
      await this.client.initialize();
      await this.client.authenticate();

      const mcpServers = acpMcpServersParam();
      if (this.options.resumeSessionId) {
        await this.client.sessionLoad({
          sessionId: this.options.resumeSessionId,
          cwd: repoPath,
          mcpServers,
        });
        this.sessionId = this.options.resumeSessionId;
      } else {
        const session = await this.client.sessionNew({
          cwd: repoPath,
          mcpServers,
        });
        this.sessionId = session.sessionId;
      }
      this.ledger.sessionId = this.sessionId;
      this.ledger.sessionResumed = Boolean(
        this.options.resumeSessionId || this.options.resumeRunId,
      );
      store.bindSession(this.ledger.runId, this.sessionId, this.ledger);

      console.log(
        chalk.dim(
          `Session: ${this.sessionId}${this.ledger.sessionResumed ? " (resumed)" : " (new)"}`,
        ),
      );
      console.log(chalk.dim(`Run: ${this.ledger.runId}`));

      await this.applyModelForPhase(startPhase);

      this.client.onUpdateTodos((params) => this.handleTodos(params));

      await this.runPhaseLoop(startPhase);

      this.ledger.sentinelCountAfter = countSentinels(
        repoPath,
        this.ledger.runId,
      );
      this.persistLedger();

      if (this.stoppedAfterPlan) {
        return { ledger: this.ledger, report: null, reportPath: null };
      }

      store.markCompleted(this.ledger.runId, this.ledger);

      let report: FinalReport | null = null;
      let reportPath: string | null = null;

      if (this.options.writeReport) {
        const { emitHtmlReport } = await import("../report/emit.js");
        report = buildFinalReportFromLedger(this.ledger, {
          runLifecycleStatus: "completed",
          currentPhase: "done",
        });
        reportPath = await emitHtmlReport(report, {
          open: this.options.openReport,
        });
      }

      return { ledger: this.ledger, report, reportPath };
    } catch (err) {
      if (this.ledger?.status === "running" && !this.interrupted) {
        const message = err instanceof Error ? err.message : String(err);
        store.markFailed(this.ledger.runId, this.ledger, message);
        store.markInterrupted(this.ledger.runId, this.ledger);
        this.persistLedger();
      }
      throw err;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await this.client.stop();
      this.liveTrace.endPhase();
      this.spinner?.stop();
    }
  }

  private async runPhaseLoop(startPhase: Phase = "hypothesize"): Promise<void> {
    let phase: Phase = startPhase;
    const store = getRunStore();

    while (phase !== "done") {
      this.ledger.phase = phase;
      await this.applyModelForPhase(phase);
      store.recordPhaseStart(this.ledger.runId, phase, this.ledger);
      this.options.onPhase?.(phase);
      this.options.runLog?.section(`phase:${phase}`);
      this.trace.setPhase(phase);
      this.liveTrace.beginPhase(phase);
      this.spinner = ora(chalk.cyan(`Phase: ${phase}`)).start();

      let nextPhase: Phase = "done";

      switch (phase) {
        case "hypothesize":
          await this.client.setMode(this.sessionId, "plan");
          await this.sendPhasePrompt("hypothesize");
          if (this.options.confirmPlan) {
            const ok = await confirmPlanAfterHypothesis(this.ledger);
            if (!ok) {
              this.ledger.status = "partial";
              this.stoppedAfterPlan = true;
              nextPhase = "done";
              this.options.runLog?.line("User stopped after plan confirmation");
              getRunStore().markInterrupted(this.ledger.runId, this.ledger);
              break;
            }
          }
          nextPhase = "instrument";
          break;

        case "instrument":
          await this.client.setMode(this.sessionId, "agent");
          this.ledger.sentinelCountBefore = countSentinels(
            this.ledger.repoPath,
            this.ledger.runId,
          );
          await this.sendPhasePrompt("instrument");
          nextPhase = "reproduce";
          break;

        case "reproduce":
          this.logSinceTs = Date.now();
          await this.sendPhasePrompt("reproduce");
          if (this.ledger.verifyMode === "browser") {
            const entries = await waitForDebugLog({
              repoPath: this.ledger.repoPath,
              sinceTs: this.logSinceTs - 60_000,
              minEntries: 1,
              timeoutMs: 90_000,
            });
            this.ledger.logEntries = entries;
          } else {
            this.ledger.logEntries = readDebugLogSince(
              this.ledger.repoPath,
              this.logSinceTs - 60_000,
            );
          }
          nextPhase = "analyze";
          break;

        case "analyze":
          await this.sendPhasePrompt("analyze");
          nextPhase = "apply_fix";
          break;

        case "apply_fix":
          await this.sendPhasePrompt("apply_fix");
          nextPhase = "verify";
          break;

        case "verify": {
          this.ledger.cycles += 1;
          await this.sendPhasePrompt("verify");
          const verified = this.parseVerified(this.ledger.streamBuffer);
          if (verified || this.ledger.cycles >= this.options.maxCycles) {
            if (!verified && this.ledger.cycles >= this.options.maxCycles) {
              this.ledger.status = "partial";
            }
            this.markFixedNext = "review";
            this.markFixedRetries = 0;
            nextPhase = "mark_fixed";
          } else {
            nextPhase = "analyze";
          }
          break;
        }

        case "mark_fixed":
          nextPhase = await this.runMarkFixedPhase();
          break;

        case "review":
          await this.sendPhasePrompt("review");
          nextPhase =
            this.ledger.reviewComments.length > 0
              ? "apply_review"
              : "re_verify";
          break;

        case "apply_review":
          await this.sendPhasePrompt("apply_review");
          nextPhase = "re_verify";
          break;

        case "re_verify": {
          this.ledger.reviewCycles = (this.ledger.reviewCycles ?? 0) + 1;
          await this.sendPhasePrompt("re_verify");
          const ok = this.parseVerified(this.ledger.streamBuffer);
          if (!ok && this.ledger.reviewComments.some((c) => !c.addressed)) {
            nextPhase = "apply_review";
          } else {
            this.markFixedNext = "summarize";
            this.markFixedRetries = 0;
            nextPhase =
              this.remainingSentinels() > 0 ? "mark_fixed" : "summarize";
          }
          break;
        }

        case "summarize":
          if (this.remainingSentinels() > 0) {
            this.markFixedNext = "summarize";
            this.markFixedRetries = 0;
            console.log(
              chalk.yellow(
                "Instrumentation still present before summarize — running mark_fixed cleanup.",
              ),
            );
            nextPhase = "mark_fixed";
            break;
          }
          await this.sendPhasePrompt("summarize");
          this.ledger.status =
            this.ledger.status === "partial" ? "partial" : "fixed";
          nextPhase = "done";
          break;
      }

      store.recordPhaseComplete(
        this.ledger.runId,
        phase,
        nextPhase,
        this.ledger,
      );
      phase = nextPhase;

      this.spinner?.stop();
      this.liveTrace.endPhase();
      this.spinner?.succeed(chalk.green(`Done: ${this.ledger.phase}`));
      this.trace.flushTextBuffer();
      this.ledger.trace = this.trace.getEntries();
      this.ledger.streamBuffer = "";
    }
  }

  private async applyModelForPhase(phase: Phase): Promise<void> {
    const modelId = modelForPhase(phase, this.options.agentConfig.models);
    if (modelId === this.activeModel) return;
    await this.client.setModel(this.sessionId, modelId);
    this.activeModel = modelId;
    this.ledger.model = this.options.agentConfig.models.fixer;
    this.ledger.plannerModel = this.options.agentConfig.models.planner;
    this.ledger.reviewer = this.options.agentConfig.models.reviewer;
  }

  private remainingSentinels(): number {
    return countSentinels(this.ledger.repoPath, this.ledger.runId);
  }

  /**
   * Run mark_fixed with sentinel checks; retry up to 2 times if cleanup incomplete.
   */
  private async runMarkFixedPhase(): Promise<Phase> {
    const remainingBefore = this.remainingSentinels();
    await this.sendPhasePrompt("mark_fixed", {
      sentinelCountRemaining: remainingBefore,
      markFixedRetryAttempt: this.markFixedRetries,
    });
    this.ledger.sentinelCountAfter = this.remainingSentinels();

    if (this.ledger.sentinelCountAfter > 0 && this.markFixedRetries < 2) {
      this.markFixedRetries += 1;
      this.options.runLog?.line(
        `mark_fixed: ${this.ledger.sentinelCountAfter} sentinel(s) remain, retry ${this.markFixedRetries}`,
      );
      console.log(
        chalk.yellow(
          `Instrumentation cleanup incomplete (${this.ledger.sentinelCountAfter} sentinel(s) left) — retrying mark_fixed.`,
        ),
      );
      return "mark_fixed";
    }

    if (this.ledger.sentinelCountAfter > 0) {
      console.log(
        chalk.yellow(
          `Warning: ${this.ledger.sentinelCountAfter} DEBUG-INSTRUMENT sentinel(s) still in repo after mark_fixed.`,
        ),
      );
    }
    this.markFixedRetries = 0;
    return this.markFixedNext;
  }

  private async sendPhasePrompt(
    phase: Phase,
    extra?: Pick<PromptContext, "sentinelCountRemaining" | "markFixedRetryAttempt">,
  ): Promise<void> {
    const stored = this.ledger.logEntries as ReturnType<typeof readDebugLogSince>;
    const logSnippet =
      stored.length > 0
        ? JSON.stringify(groupByHypothesis(stored), null, 2)
        : fs.existsSync(debugLogPath(this.ledger.repoPath))
          ? fs.readFileSync(debugLogPath(this.ledger.repoPath), "utf8").slice(-4000)
          : undefined;

    const text = getPromptForPhase(phase, {
      ledger: this.ledger,
      logSnippet,
      sinceTs: this.logSinceTs,
      ...extra,
    });

    this.options.runLog?.line(`prompt:${phase} bytes=${text.length}`);

    await this.client.sessionPrompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });

    this.parsePhaseResult(phase, this.ledger.streamBuffer);
    this.options.runLog?.line(
      `phase:${phase} streamBytes=${this.ledger.streamBuffer.length}`,
    );
  }

  private parsePhaseResult(phase: Phase, buffer: string): void {
    switch (phase) {
      case "hypothesize": {
        const data = extractJsonFromText<{ hypotheses?: Hypothesis[] }>(buffer);
        if (data?.hypotheses?.length) {
          this.ledger.hypotheses = data.hypotheses;
        } else if (this.ledger.todos.length) {
          this.ledger.hypotheses = this.ledger.todos.map((t, i) => ({
            id: t.id,
            rank: i + 1,
            statement: t.content,
            status: "pending" as const,
          }));
        }
        break;
      }
      case "instrument": {
        const data = extractJsonFromText<{ filesTouched?: string[] }>(buffer);
        if (data?.filesTouched) {
          this.ledger.filesTouched = data.filesTouched;
        }
        break;
      }
      case "reproduce": {
        const data = extractJsonFromText<{ steps?: string[] }>(buffer);
        if (data?.steps) this.ledger.reproductionSteps = data.steps;
        break;
      }
      case "analyze": {
        const data = extractJsonFromText<{
          confirmedHypothesis?: string;
          fixProposal?: string;
        }>(buffer);
        if (data?.confirmedHypothesis) {
          this.ledger.confirmedHypothesisId = data.confirmedHypothesis;
          const h = this.ledger.hypotheses.find(
            (x) => x.id === data.confirmedHypothesis,
          );
          if (h) h.status = "confirmed";
        }
        if (data?.fixProposal) this.ledger.fixProposed = data.fixProposal;
        break;
      }
      case "mark_fixed": {
        const data = extractJsonFromText<{ cleaned?: boolean }>(buffer);
        if (data?.cleaned === false) {
          this.options.runLog?.line("mark_fixed: agent reported cleaned=false");
        }
        break;
      }
      case "apply_review": {
        const data = extractJsonFromText<{ addressed?: string[] }>(buffer);
        if (data?.addressed?.length) {
          for (const id of data.addressed) {
            const comment = this.ledger.reviewComments.find((c) => c.id === id);
            if (comment) comment.addressed = true;
          }
        }
        break;
      }
      case "review": {
        const data = extractJsonFromText<{
          comments?: Array<{ id: string; text: string; addressed?: boolean }>;
        }>(buffer);
        if (data?.comments) {
          this.ledger.reviewComments = data.comments.map((c) => ({
            id: c.id,
            text: c.text,
            addressed: c.addressed ?? false,
          }));
        }
        break;
      }
      case "summarize": {
        const data = extractJsonFromText<Record<string, unknown>>(buffer);
        const parsed = RunSummarySchema.safeParse(data);
        if (parsed.success) this.ledger.summary = parsed.data;
        break;
      }
    }
  }

  private parseVerified(buffer: string): boolean {
    const data = extractJsonFromText<{ verified?: boolean }>(buffer);
    return data?.verified === true;
  }

  private pushLiveTrace(): void {
    const recent = this.trace.getRecent(1);
    const last = recent[recent.length - 1];
    if (!last || last.kind === "phase") return;
    this.spinner?.clear();
    this.liveTrace.push(last);
    if (this.spinner?.isSpinning) {
      this.spinner.render();
    }
  }

  private handleTodos(params: CursorUpdateTodosParams): void {
    this.ledger.todos = params.todos.map((t) => ({
      id: t.id,
      content: t.content,
      status: t.status,
    }));
  }

  private persistLedger(): void {
    const outPath = debugRunLedgerPath(this.ledger.repoPath, this.ledger.runId);
    fs.writeFileSync(outPath, JSON.stringify(this.ledger, null, 2));
  }
}
