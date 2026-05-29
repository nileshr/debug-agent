import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ora, { type Ora } from "ora";
import chalk from "chalk";
import { AcpClient } from "../acp/client.js";
import { acpMcpServersParam, ensureChromeDevToolsMcpConfig } from "../mcp/chrome.js";
import {
  countSentinels,
  debugLogPath,
  groupByHypothesis,
  readDebugLogSince,
  waitForDebugLog,
} from "./log-tail.js";
import {
  extractJsonFromText,
  getPromptForPhase,
} from "./prompts.js";
import type { VerifyMode } from "./types.js";
import {
  FinalReportSchema,
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
import {
  formatAgentResumeCommand,
  formatDebugResumeCommand,
} from "./session-info.js";

export interface ControllerOptions {
  repoPath: string;
  verifyMode: VerifyMode;
  url?: string;
  bugDescription: string;
  model?: string;
  reviewer?: string;
  maxCycles?: number;
  writeReport?: boolean;
  openReport?: boolean;
  resumeSessionId?: string;
  onPhase?: (phase: Phase) => void;
}

export interface ControllerResult {
  ledger: RunLedger;
  report: FinalReport | null;
  reportPath: string | null;
}

export class DebugLoopController {
  private client: AcpClient;
  private readonly options: Required<
    Pick<ControllerOptions, "model" | "reviewer" | "maxCycles" | "writeReport" | "openReport">
  > &
    ControllerOptions;
  private ledger!: RunLedger;
  private sessionId!: string;
  private spinner: Ora | null = null;
  private logSinceTs = 0;
  private readonly trace = new AgentTraceCollector();
  private readonly liveTrace = new LiveTraceDisplay(5);

  constructor(options: ControllerOptions) {
    this.options = {
      model: options.model ?? "composer-2.5[fast=true]",
      reviewer: options.reviewer ?? "code-review",
      maxCycles: options.maxCycles ?? 5,
      writeReport: options.writeReport ?? true,
      openReport: options.openReport ?? true,
      ...options,
    };
    this.client = new AcpClient({
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
    const runId = randomUUID().slice(0, 8);

    this.ledger = {
      runId,
      sessionId: "",
      sessionResumed: Boolean(this.options.resumeSessionId),
      repoPath,
      verifyMode: this.options.verifyMode,
      url: this.options.url,
      bugDescription: this.options.bugDescription,
      model: this.options.model,
      reviewer: this.options.reviewer,
      startedAt: Date.now(),
      phase: "hypothesize",
      cycles: 0,
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

    fs.mkdirSync(path.join(repoPath, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(repoPath, ".cursor", "debug-runs"), { recursive: true });
    if (this.options.verifyMode === "browser") {
      ensureChromeDevToolsMcpConfig(repoPath);
    }

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
      this.ledger.sessionResumed = Boolean(this.options.resumeSessionId);

      console.log(
        chalk.dim(
          `Session: ${this.sessionId}${this.ledger.sessionResumed ? " (resumed)" : " (new)"}`,
        ),
      );

      await this.client.setModel(this.sessionId, this.options.model);

      this.client.onUpdateTodos((params) => this.handleTodos(params));

      await this.runPhaseLoop();

      this.ledger.sentinelCountAfter = countSentinels(repoPath, runId);
      this.persistLedger();

      let report: FinalReport | null = null;
      let reportPath: string | null = null;

      if (this.options.writeReport) {
        const { emitHtmlReport } = await import("../report/emit.js");
        report = this.buildFinalReport();
        reportPath = await emitHtmlReport(report, {
          open: this.options.openReport,
        });
      }

      return { ledger: this.ledger, report, reportPath };
    } finally {
      await this.client.stop();
      this.liveTrace.endPhase();
      this.spinner?.stop();
    }
  }

  private async runPhaseLoop(): Promise<void> {
    let phase: Phase = "hypothesize";

    while (phase !== "done") {
      this.ledger.phase = phase;
      this.options.onPhase?.(phase);
      this.trace.setPhase(phase);
      this.liveTrace.beginPhase(phase);
      this.spinner = ora(chalk.cyan(`Phase: ${phase}`)).start();

      switch (phase) {
        case "hypothesize":
          await this.client.setMode(this.sessionId, "plan");
          await this.sendPhasePrompt("hypothesize");
          phase = "instrument";
          break;

        case "instrument":
          await this.client.setMode(this.sessionId, "agent");
          this.ledger.sentinelCountBefore = countSentinels(
            this.ledger.repoPath,
            this.ledger.runId,
          );
          await this.sendPhasePrompt("instrument");
          phase = "reproduce";
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
          phase = "analyze";
          break;

        case "analyze":
          await this.sendPhasePrompt("analyze");
          phase = "apply_fix";
          break;

        case "apply_fix":
          await this.sendPhasePrompt("apply_fix");
          phase = "verify";
          break;

        case "verify": {
          this.ledger.cycles += 1;
          await this.sendPhasePrompt("verify");
          const verified = this.parseVerified(this.ledger.streamBuffer);
          if (verified || this.ledger.cycles >= this.options.maxCycles) {
            phase = verified ? "mark_fixed" : "analyze";
            if (!verified && this.ledger.cycles >= this.options.maxCycles) {
              this.ledger.status = "partial";
              phase = "mark_fixed";
            }
          } else {
            phase = "analyze";
          }
          break;
        }

        case "mark_fixed":
          await this.sendPhasePrompt("mark_fixed");
          this.ledger.sentinelCountAfter = countSentinels(
            this.ledger.repoPath,
            this.ledger.runId,
          );
          phase = "review";
          break;

        case "review":
          await this.sendPhasePrompt("review");
          phase =
            this.ledger.reviewComments.length > 0
              ? "apply_review"
              : "re_verify";
          break;

        case "apply_review":
          await this.sendPhasePrompt("apply_review");
          phase = "re_verify";
          break;

        case "re_verify": {
          await this.sendPhasePrompt("re_verify");
          const ok = this.parseVerified(this.ledger.streamBuffer);
          if (!ok && this.ledger.reviewComments.some((c) => !c.addressed)) {
            phase = "apply_review";
          } else {
            phase = "summarize";
          }
          break;
        }

        case "summarize":
          await this.sendPhasePrompt("summarize");
          this.ledger.status =
            this.ledger.status === "partial" ? "partial" : "fixed";
          phase = "done";
          break;
      }

      this.spinner?.stop();
      this.liveTrace.endPhase();
      this.spinner?.succeed(chalk.green(`Done: ${this.ledger.phase}`));
      this.trace.flushTextBuffer();
      this.ledger.trace = this.trace.getEntries();
      this.ledger.streamBuffer = "";
    }
  }

  private async sendPhasePrompt(phase: Phase): Promise<void> {
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
    });

    await this.client.sessionPrompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });

    this.parsePhaseResult(phase, this.ledger.streamBuffer);
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
    const outPath = path.join(
      this.ledger.repoPath,
      ".cursor",
      "debug-runs",
      `${this.ledger.runId}.json`,
    );
    fs.writeFileSync(outPath, JSON.stringify(this.ledger, null, 2));
  }

  private buildFinalReport(): FinalReport {
    const endedAt = Date.now();
    const summary = this.ledger.summary ?? {
      bugSummary: this.ledger.bugDescription,
      rootCause: this.ledger.fixProposed ?? "See transcript",
      fixExplanation: "See agent transcript",
      risks: [],
      followUps: [],
    };

    return FinalReportSchema.parse({
      runId: this.ledger.runId,
      sessionId: this.ledger.sessionId,
      repoPath: this.ledger.repoPath,
      verifyMode: this.ledger.verifyMode,
      url: this.ledger.url,
      bugDescription: this.ledger.bugDescription,
      status: this.ledger.status === "running" ? "partial" : this.ledger.status,
      model: this.ledger.model,
      startedAt: new Date(this.ledger.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      elapsedMs: endedAt - this.ledger.startedAt,
      cycles: this.ledger.cycles,
      hypotheses: this.ledger.hypotheses,
      instrumentation: {
        filesTouched: this.ledger.filesTouched,
        sentinelCountBefore: this.ledger.sentinelCountBefore,
        sentinelCountAfter: this.ledger.sentinelCountAfter,
      },
      reproduction: {
        mode: this.ledger.verifyMode,
        url: this.ledger.url,
        steps: this.ledger.reproductionSteps,
        logEntries: this.ledger.logEntries,
      },
      fix: {
        diffStat: undefined,
        rootCause: summary.rootCause,
        explanation: summary.fixExplanation,
      },
      review: { comments: this.ledger.reviewComments },
      summary,
      session: {
        sessionId: this.ledger.sessionId,
        resumed: this.ledger.sessionResumed,
        debugResumeCommand: formatDebugResumeCommand({
          sessionId: this.ledger.sessionId,
          repoPath: this.ledger.repoPath,
          bugDescription: this.ledger.bugDescription,
          url: this.ledger.url,
        }),
        agentResumeCommand: formatAgentResumeCommand(this.ledger.sessionId),
      },
      trace: this.ledger.trace,
      transcript: this.ledger.transcript.slice(-50),
    });
  }
}
