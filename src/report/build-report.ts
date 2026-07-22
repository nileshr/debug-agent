import type { PhaseTimelineEntry, FinalReport, Hypothesis, RunLedger } from "../debug/types.js";
import { FinalReportSchema } from "../debug/types.js";
import {
  formatAgentResumeCommand,
  formatDebugResumeCommand,
} from "../debug/session-info.js";
import type { RunLifecycleStatus } from "../debug/run-store.js";

export interface BuildFinalReportOptions {
  endedAt?: number;
  runLifecycleStatus?: RunLifecycleStatus;
  currentPhase?: string;
  phaseTimeline?: PhaseTimelineEntry[];
}

/** Normalize hypothesis statuses using confirmedHypothesisId from analysis. */
export function enrichHypotheses(
  hypotheses: Hypothesis[],
  confirmedHypothesisId?: string,
): Hypothesis[] {
  if (!confirmedHypothesisId || hypotheses.length === 0) {
    return hypotheses;
  }

  return hypotheses.map((h) => {
    if (h.id === confirmedHypothesisId) {
      return { ...h, status: "confirmed" as const };
    }
    if (h.status === "pending") {
      return { ...h, status: "rejected" as const };
    }
    return h;
  });
}

/** Count re_verify attempts; falls back to trace when ledger field is missing. */
export function resolveReviewCycles(ledger: RunLedger): number {
  if (ledger.reviewCycles != null && ledger.reviewCycles > 0) {
    return ledger.reviewCycles;
  }
  return ledger.trace.filter(
    (e) => e.kind === "phase" && e.text === "Started re_verify",
  ).length;
}

export function buildFinalReportFromLedger(
  ledger: RunLedger,
  options: BuildFinalReportOptions = {},
): FinalReport {
  const endedAt = options.endedAt ?? Date.now();
  const summary = ledger.summary ?? {
    bugSummary: ledger.bugDescription,
    rootCause: ledger.fixProposed ?? "See transcript",
    fixExplanation: "See agent transcript",
    risks: [],
    followUps: [],
  };

  const runStatus =
    ledger.status === "running" ? "partial" : ledger.status;

  return FinalReportSchema.parse({
    runId: ledger.runId,
    sessionId: ledger.sessionId,
    repoPath: ledger.repoPath,
    verifyMode: ledger.verifyMode,
    url: ledger.url,
    bugDescription: ledger.bugDescription,
    status: runStatus,
    runLifecycleStatus: options.runLifecycleStatus,
    currentPhase: options.currentPhase ?? ledger.phase,
    model: ledger.model,
    startedAt: new Date(ledger.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    elapsedMs: endedAt - ledger.startedAt,
    cycles: ledger.cycles,
    reviewCycles: resolveReviewCycles(ledger),
    confirmedHypothesisId: ledger.confirmedHypothesisId,
    hypotheses: enrichHypotheses(
      ledger.hypotheses,
      ledger.confirmedHypothesisId,
    ),
    instrumentation: {
      filesTouched: ledger.filesTouched,
      sentinelCountBefore: ledger.sentinelCountBefore,
      sentinelCountAfter: ledger.sentinelCountAfter,
    },
    reproduction: {
      mode: ledger.verifyMode,
      url: ledger.url,
      steps: ledger.reproductionSteps,
      logEntries: ledger.logEntries,
    },
    fix: {
      diffStat: undefined,
      rootCause: summary.rootCause,
      explanation: summary.fixExplanation,
    },
    review: { comments: ledger.reviewComments },
    summary,
    session: {
      sessionId: ledger.sessionId,
      resumed: ledger.sessionResumed,
      debugResumeCommand: formatDebugResumeCommand({
        runId: ledger.runId,
        sessionId: ledger.sessionId,
        repoPath: ledger.repoPath,
        bugDescription: ledger.bugDescription,
        url: ledger.url,
      }),
      agentResumeCommand: formatAgentResumeCommand(ledger.sessionId),
    },
    trace: ledger.trace,
    transcript: ledger.transcript.slice(-50),
    phaseTimeline: options.phaseTimeline,
    stepTimeline: ledger.stepHistory?.length ? ledger.stepHistory : undefined,
    decisionTimeline: ledger.decisions?.length ? ledger.decisions : undefined,
  });
}
