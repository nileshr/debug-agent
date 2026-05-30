import fs from "node:fs";
import path from "node:path";
import type { PhaseTimelineEntry, ReviewComment, RunLedger } from "./types.js";
import { debugRunLedgerPath } from "./repo-paths.js";
import {
  getRunStore,
  type LoadedRun,
  type RunLifecycleStatus,
} from "./run-store.js";

function parseFileLedger(json: string): RunLedger {
  const raw = JSON.parse(json) as RunLedger;
  return {
    ...raw,
    plannerModel: raw.plannerModel ?? raw.model,
    browserMcp: raw.browserMcp ?? "playwright",
    streamBuffer: "",
    transcript: raw.transcript ?? [],
    trace: raw.trace ?? [],
    logEntries: raw.logEntries ?? [],
    hypotheses: raw.hypotheses ?? [],
    todos: raw.todos ?? [],
    filesTouched: raw.filesTouched ?? [],
    reproductionSteps: raw.reproductionSteps ?? [],
    reviewComments: raw.reviewComments ?? [],
  };
}

/** Merge DB ledger with on-disk ledger (file may have fuller trace/transcript). */
function mergeReviewComments(
  a: ReviewComment[],
  b: ReviewComment[],
): ReviewComment[] {
  const byId = new Map<string, ReviewComment>();
  for (const c of [...a, ...b]) {
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, c);
    } else {
      byId.set(c.id, {
        ...prev,
        ...c,
        addressed: prev.addressed || c.addressed,
      });
    }
  }
  return [...byId.values()];
}

export function mergeLedgers(dbLedger: RunLedger, fileLedger: RunLedger): RunLedger {
  return {
    ...dbLedger,
    ...fileLedger,
    runId: dbLedger.runId,
    sessionId: fileLedger.sessionId || dbLedger.sessionId,
    trace:
      fileLedger.trace.length >= dbLedger.trace.length
        ? fileLedger.trace
        : dbLedger.trace,
    transcript:
      fileLedger.transcript.length >= dbLedger.transcript.length
        ? fileLedger.transcript
        : dbLedger.transcript,
    reviewComments: mergeReviewComments(
      dbLedger.reviewComments,
      fileLedger.reviewComments,
    ),
    hypotheses:
      fileLedger.hypotheses.length >= dbLedger.hypotheses.length
        ? fileLedger.hypotheses
        : dbLedger.hypotheses,
    confirmedHypothesisId:
      fileLedger.confirmedHypothesisId ?? dbLedger.confirmedHypothesisId,
    reviewCycles: Math.max(
      fileLedger.reviewCycles ?? 0,
      dbLedger.reviewCycles ?? 0,
    ),
  };
}

export function loadFileLedger(
  repoPath: string,
  runId: string,
): RunLedger | null {
  const filePath = debugRunLedgerPath(repoPath, runId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseFileLedger(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export interface ResolvedRunForReport {
  runId: string;
  repoPath: string;
  runLifecycleStatus: RunLifecycleStatus;
  currentPhase: string;
  endedAt: number;
  ledger: RunLedger;
  phaseTimeline: PhaseTimelineEntry[];
}

export function resolveReportRunId(
  repoPath: string,
  explicitRunId?: string,
): string {
  const store = getRunStore();
  const resolvedRepo = repoPath;

  if (explicitRunId?.trim()) {
    return explicitRunId.trim();
  }

  for (const status of ["running", "interrupted"] as const) {
    const rows = store.listRuns({
      repoPath: resolvedRepo,
      runStatus: status,
      limit: 1,
    });
    if (rows.length > 0) return rows[0]!.runId;
  }

  const latest = store.listRuns({ repoPath: resolvedRepo, limit: 1 });
  if (latest.length === 0) {
    throw new Error(`No debug runs found for ${resolvedRepo}`);
  }
  return latest[0]!.runId;
}

export function loadRunForReport(
  repoPath: string,
  runId: string,
): ResolvedRunForReport {
  const store = getRunStore();
  const loaded = store.loadRun(runId);
  if (!loaded) {
    throw new Error(`Run not found: ${runId}`);
  }
  if (path.resolve(loaded.repoPath) !== path.resolve(repoPath)) {
    throw new Error(
      `Run ${runId} belongs to ${loaded.repoPath}, not ${repoPath}`,
    );
  }

  const fileLedger = loadFileLedger(repoPath, runId);
  const ledger = fileLedger
    ? mergeLedgers(loaded.ledger, fileLedger)
    : loaded.ledger;

  const phaseTimeline = store.getPhaseTimeline(runId);
  const endedAt = resolveEndedAt(loaded, phaseTimeline);

  return {
    runId,
    repoPath,
    runLifecycleStatus: loaded.runStatus,
    currentPhase: loaded.nextPhase,
    endedAt,
    ledger,
    phaseTimeline,
  };
}

function resolveEndedAt(
  loaded: LoadedRun,
  phaseTimeline: PhaseTimelineEntry[],
): number {
  if (loaded.runStatus === "completed" || loaded.runStatus === "failed") {
    const summarize = phaseTimeline.find((p) => p.phase === "summarize");
    if (summarize?.completedAt) return summarize.completedAt;
    return Date.now();
  }
  const lastCompleted = phaseTimeline
    .filter((p) => p.completedAt != null)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
  return lastCompleted?.completedAt ?? Date.now();
}