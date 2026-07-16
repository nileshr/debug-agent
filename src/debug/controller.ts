import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ora, { type Ora } from "ora";
import chalk from "chalk";
import { AcpRuntime } from "../runtime/acp/adapter.js";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeSession,
} from "../runtime/types.js";
import type { ResolvedAgentConfig } from "../config/types.js";
import { acpMcpServersParam, ensureBrowserMcpConfig } from "../mcp/browser.js";
import { countSentinels } from "./log-tail.js";
import { debugRunsDir, debugRunLedgerPath } from "./repo-paths.js";
import { LoopEngine } from "../engine/engine.js";
import { buildFinalReportFromLedger } from "../report/build-report.js";
import type { VerifyMode } from "./types.js";
import type { FinalReport, Phase, RunLedger } from "./types.js";
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
  /** Inject a pre-built agent runtime (tests, alternative runtimes). */
  runtime?: AgentRuntime;
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
  private runtime!: AgentRuntime;
  private session!: RuntimeSession;
  private readonly options: Required<
    Pick<ControllerOptions, "maxCycles" | "writeReport" | "openReport">
  > &
    ControllerOptions;
  private ledger!: RunLedger;
  private sessionId!: string;
  private spinner: Ora | null = null;
  private readonly trace = new AgentTraceCollector();
  private readonly liveTrace = new LiveTraceDisplay(5);
  private interrupted = false;
  private stoppedAfterPlan = false;

  constructor(options: ControllerOptions) {
    this.options = {
      maxCycles: options.maxCycles ?? 5,
      writeReport: options.writeReport ?? true,
      openReport: options.openReport ?? true,
      ...options,
    };
  }

  private handleRuntimeEvent(ev: RuntimeEvent): void {
    if (!this.ledger) return;
    switch (ev.type) {
      case "text":
        this.ledger.streamBuffer += ev.text;
        this.ledger.transcript.push(ev.text);
        this.trace.appendStreamChunk(ev.text);
        this.pushLiveTrace();
        break;
      case "trace":
        this.trace.add(ev.kind, ev.text);
        this.pushLiveTrace();
        break;
      case "plan":
        this.ledger.todos = ev.entries.map((t) => ({
          id: t.id ?? "",
          content: t.content,
          status: t.status,
        }));
        break;
    }
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
        ledgerVersion: 2,
        runtime: "acp",
        agentPreset: "cursor",
        autonomy: "static",
        stepHistory: [],
        decisions: [],
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

    const resuming = Boolean(
      this.options.resumeSessionId || this.options.resumeRunId,
    );
    this.runtime =
      this.options.runtime ??
      new AcpRuntime({
        repoPath,
        mcpServers: acpMcpServersParam(),
        permissionPolicy: { repoPath },
        // Fresh sessions start on the fixer model; on resume force a re-send.
        initialModelId: resuming
          ? undefined
          : this.options.agentConfig.models.fixer,
        onEvent: (ev) => this.handleRuntimeEvent(ev),
      });

    try {
      await this.runtime.start();

      if (this.options.resumeSessionId) {
        this.session = await this.runtime.resumeSession(
          this.options.resumeSessionId,
        );
      } else {
        this.session = await this.runtime.createSession();
      }
      this.sessionId = this.session.sessionId;
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
      await this.runtime.stop();
      this.liveTrace.endPhase();
      this.spinner?.stop();
    }
  }

  private async runPhaseLoop(startPhase: Phase = "hypothesize"): Promise<void> {
    const engine = new LoopEngine({
      ledger: this.ledger,
      session: this.session,
      agentConfig: this.options.agentConfig,
      maxCycles: this.options.maxCycles,
      runLog: this.options.runLog,
      confirmPlanGate: this.options.confirmPlan
        ? () => confirmPlanAfterHypothesis(this.ledger)
        : undefined,
      callbacks: {
        onStepStart: (stepId) => {
          this.options.onPhase?.(stepId as Phase);
          this.options.runLog?.section(`phase:${stepId}`);
          this.trace.setPhase(stepId);
          this.liveTrace.beginPhase(stepId);
          this.spinner = ora(chalk.cyan(`Phase: ${stepId}`)).start();
        },
        onStepEnd: (stepId) => {
          this.spinner?.stop();
          this.liveTrace.endPhase();
          this.spinner?.succeed(chalk.green(`Done: ${stepId}`));
          this.trace.flushTextBuffer();
          this.ledger.trace = this.trace.getEntries();
          this.ledger.streamBuffer = "";
        },
      },
    });

    const result = await engine.run(startPhase);
    this.stoppedAfterPlan = result.stoppedAfterPlan;
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

  private persistLedger(): void {
    const outPath = debugRunLedgerPath(this.ledger.repoPath, this.ledger.runId);
    fs.writeFileSync(outPath, JSON.stringify(this.ledger, null, 2));
  }
}
