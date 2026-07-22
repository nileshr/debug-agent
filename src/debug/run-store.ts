import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEBUG_PHASES } from "./phases.js";
import type { DecisionRecord, Phase, RunLedger, VerifyMode } from "./types.js";

export const STATE_DB_PATH = path.join(os.homedir(), ".debug-agent", "state.db");

export type RunLifecycleStatus =
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "waiting_on_user";
export type PhaseRowStatus = "pending" | "running" | "completed" | "skipped";

export interface PhaseTimelineRow {
  phase: string;
  status: PhaseRowStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface CreateRunParams {
  runId: string;
  repoPath: string;
  bugDescription: string;
  verifyMode: VerifyMode;
  url?: string;
  model: string;
  reviewer: string;
  maxCycles: number;
}

export interface RunListRow {
  runId: string;
  sessionId: string;
  repoPath: string;
  bugDescription: string;
  verifyMode: VerifyMode;
  url?: string;
  runStatus: RunLifecycleStatus;
  finalStatus?: RunLedger["status"];
  currentPhase: Phase;
  nextPhase: Phase;
  cycles: number;
  startedAt: number;
  updatedAt: number;
}

export interface LoadedRun {
  runId: string;
  sessionId: string;
  repoPath: string;
  bugDescription: string;
  verifyMode: VerifyMode;
  url?: string;
  model: string;
  reviewer: string;
  maxCycles: number;
  runStatus: RunLifecycleStatus;
  nextPhase: Phase;
  ledger: RunLedger;
}

type RunRow = {
  run_id: string;
  session_id: string;
  repo_path: string;
  bug_description: string;
  url: string | null;
  verify_mode: string;
  model: string;
  reviewer: string;
  max_cycles: number;
  run_status: string;
  final_status: string | null;
  current_phase: string;
  next_phase: string;
  cycles: number;
  started_at: number;
  updated_at: number;
  ledger_json: string;
};

function ledgerForStorage(ledger: RunLedger): RunLedger {
  return {
    ...ledger,
    streamBuffer: "",
    transcript: ledger.transcript.slice(-50),
    trace: ledger.trace.slice(-200),
  };
}

function parseLedger(json: string): RunLedger {
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
    // v2 upgrade-on-read for ledgers written by older builds.
    ledgerVersion: raw.ledgerVersion ?? 2,
    runtime: raw.runtime ?? "acp",
    agentPreset: raw.agentPreset ?? "cursor",
    autonomy: raw.autonomy ?? "static",
    stepHistory: raw.stepHistory ?? [],
    decisions: raw.decisions ?? [],
  };
}

export class RunStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        repo_path TEXT NOT NULL,
        bug_description TEXT NOT NULL,
        url TEXT,
        verify_mode TEXT NOT NULL,
        model TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        max_cycles INTEGER NOT NULL,
        run_status TEXT NOT NULL,
        final_status TEXT,
        current_phase TEXT NOT NULL,
        next_phase TEXT NOT NULL,
        cycles INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ledger_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_phases (
        run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        PRIMARY KEY (run_id, phase),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_runs_repo_status
        ON runs(repo_path, run_status, updated_at DESC);
    `);

    const versionRow = this.db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    if ((versionRow?.user_version ?? 0) < 2) {
      this.migrateToV2();
    }
  }

  /**
   * v2: dynamic step-list support. Appends-as-executed `run_steps` replaces
   * the pre-seeded `run_phases` as the source of truth for what actually ran;
   * `decisions` records every loop-control decision. `run_phases` is kept and
   * still written for older builds sharing the same state DB.
   */
  private migrateToV2(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_steps (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        data_source TEXT,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS decisions (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        after_step TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        action TEXT NOT NULL,
        next_step TEXT,
        rationale TEXT,
        overridden_json TEXT,
        ts INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
    `);

    for (const column of [
      "runtime TEXT NOT NULL DEFAULT 'acp'",
      "agent_preset TEXT NOT NULL DEFAULT 'cursor'",
      "autonomy TEXT NOT NULL DEFAULT 'static'",
      "resume_token TEXT",
    ]) {
      try {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${column}`);
      } catch {
        // Column already exists (partially applied migration).
      }
    }

    // Seed run_steps from the executed portion of legacy run_phases rows so
    // pre-migration runs keep a step history.
    this.db.exec(`
      INSERT OR IGNORE INTO run_steps
        (run_id, seq, step_id, attempt, status, started_at, completed_at, error, data_source)
      SELECT run_id,
             ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY rowid),
             phase, 1, status, started_at, completed_at, error, NULL
      FROM run_phases
      WHERE status IN ('completed', 'running');
    `);

    this.db.exec("PRAGMA user_version = 2");
  }

  /** Append an executed-step row; returns its sequence number. */
  beginStep(runId: string, stepId: string, attempt: number): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_steps WHERE run_id = ?`)
      .get(runId) as { seq: number };
    this.db
      .prepare(
        `INSERT INTO run_steps (run_id, seq, step_id, attempt, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(runId, row.seq, stepId, attempt, Date.now());
    return row.seq;
  }

  completeStep(
    runId: string,
    seq: number,
    status: "completed" | "skipped" | "failed",
    dataSource?: string | null,
    error?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE run_steps SET status = ?, completed_at = ?, data_source = ?, error = ?
         WHERE run_id = ? AND seq = ?`,
      )
      .run(status, Date.now(), dataSource ?? null, error ?? null, runId, seq);
  }

  /** Append a loop-control decision; returns its sequence number. */
  recordDecision(runId: string, decision: DecisionRecord): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM decisions WHERE run_id = ?`)
      .get(runId) as { seq: number };
    this.db
      .prepare(
        `INSERT INTO decisions
           (run_id, seq, after_step, decided_by, action, next_step, rationale, overridden_json, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        row.seq,
        decision.afterStep,
        decision.decidedBy,
        decision.action,
        decision.nextStepId ?? null,
        decision.rationale ?? null,
        decision.overridden ? JSON.stringify(decision.overridden) : null,
        decision.ts,
      );
    return row.seq;
  }

  getStepTimeline(runId: string): Array<{
    seq: number;
    stepId: string;
    attempt: number;
    status: string;
    startedAt?: number;
    completedAt?: number;
    dataSource?: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT seq, step_id, attempt, status, started_at, completed_at, data_source
         FROM run_steps WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all(runId) as Array<{
      seq: number;
      step_id: string;
      attempt: number;
      status: string;
      started_at: number | null;
      completed_at: number | null;
      data_source: string | null;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      stepId: r.step_id,
      attempt: r.attempt,
      status: r.status,
      startedAt: r.started_at ?? undefined,
      completedAt: r.completed_at ?? undefined,
      dataSource: r.data_source ?? undefined,
    }));
  }

  getDecisions(runId: string): DecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT seq, after_step, decided_by, action, next_step, rationale, overridden_json, ts
         FROM decisions WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all(runId) as Array<{
      seq: number;
      after_step: string;
      decided_by: string;
      action: string;
      next_step: string | null;
      rationale: string | null;
      overridden_json: string | null;
      ts: number;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      afterStep: r.after_step,
      decidedBy: r.decided_by as DecisionRecord["decidedBy"],
      action: r.action as DecisionRecord["action"],
      nextStepId: r.next_step ?? undefined,
      rationale: r.rationale ?? undefined,
      overridden: r.overridden_json
        ? (JSON.parse(r.overridden_json) as DecisionRecord["overridden"])
        : undefined,
    }));
  }

  createRun(params: CreateRunParams, ledger: RunLedger): void {
    const now = Date.now();
    const insertRun = this.db.prepare(`
      INSERT INTO runs (
        run_id, session_id, repo_path, bug_description, url, verify_mode,
        model, reviewer, max_cycles, run_status, final_status,
        current_phase, next_phase, cycles, started_at, updated_at, ledger_json
      ) VALUES (
        ?, '', ?, ?, ?, ?, ?, ?, ?, 'running', NULL,
        'hypothesize', 'hypothesize', 0, ?, ?, ?
      )
    `);

    insertRun.run(
      params.runId,
      params.repoPath,
      params.bugDescription,
      params.url ?? null,
      params.verifyMode,
      params.model,
      params.reviewer,
      params.maxCycles,
      now,
      now,
      JSON.stringify(ledgerForStorage(ledger)),
    );

    const insertPhase = this.db.prepare(`
      INSERT INTO run_phases (run_id, phase, status) VALUES (?, ?, ?)
    `);
    for (const phase of DEBUG_PHASES) {
      insertPhase.run(
        params.runId,
        phase,
        phase === "hypothesize" ? "pending" : "pending",
      );
    }
  }

  reopenRun(runId: string, ledger: RunLedger): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs SET run_status = 'running', final_status = NULL, updated_at = ?, ledger_json = ? WHERE run_id = ?`,
      )
      .run(now, JSON.stringify(ledgerForStorage(ledger)), runId);
  }

  bindSession(runId: string, sessionId: string, ledger: RunLedger): void {
    this.updateRunRow(runId, {
      sessionId,
      ledger,
    });
  }

  recordPhaseStart(runId: string, phase: Phase, ledger: RunLedger): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE run_phases SET status = 'running', started_at = ? WHERE run_id = ? AND phase = ?`,
      )
      .run(now, runId, phase);
    this.updateRunRow(runId, {
      currentPhase: phase,
      ledger,
    });
  }

  recordPhaseComplete(
    runId: string,
    phase: Phase,
    nextPhase: Phase,
    ledger: RunLedger,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE run_phases SET status = 'completed', completed_at = ? WHERE run_id = ? AND phase = ?`,
      )
      .run(now, runId, phase);
    this.updateRunRow(runId, {
      currentPhase: phase,
      nextPhase,
      cycles: ledger.cycles,
      ledger,
    });
  }

  markInterrupted(runId: string, ledger: RunLedger): void {
    const row = this.getRunRow(runId);
    if (!row || row.run_status !== "running") return;
    const now = Date.now();
    const resumePhase = ledger.phase === "done" ? "summarize" : ledger.phase;
    this.db
      .prepare(
        `UPDATE runs SET
          run_status = 'interrupted',
          current_phase = ?,
          next_phase = ?,
          updated_at = ?,
          ledger_json = ?,
          session_id = ?
        WHERE run_id = ?`,
      )
      .run(
        resumePhase,
        resumePhase,
        now,
        JSON.stringify(ledgerForStorage(ledger)),
        ledger.sessionId,
        runId,
      );
  }

  /** Pause a run pending user answers; resume continues at `resumeStep`. */
  markWaitingOnUser(runId: string, ledger: RunLedger, resumeStep: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs SET
          run_status = 'waiting_on_user',
          current_phase = ?,
          next_phase = ?,
          updated_at = ?,
          ledger_json = ?,
          session_id = ?
        WHERE run_id = ?`,
      )
      .run(
        ledger.phase,
        resumeStep,
        now,
        JSON.stringify(ledgerForStorage(ledger)),
        ledger.sessionId,
        runId,
      );
  }

  markCompleted(runId: string, ledger: RunLedger): void {
    const finalStatus =
      ledger.status === "running" ? "partial" : ledger.status;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs SET
          run_status = 'completed',
          final_status = ?,
          current_phase = 'summarize',
          next_phase = 'done',
          updated_at = ?,
          ledger_json = ?,
          cycles = ?,
          session_id = ?
        WHERE run_id = ?`,
      )
      .run(
        finalStatus,
        now,
        JSON.stringify(ledgerForStorage({ ...ledger, status: finalStatus })),
        ledger.cycles,
        ledger.sessionId,
        runId,
      );

    this.db
      .prepare(
        `UPDATE run_phases SET status = 'completed', completed_at = ? WHERE run_id = ? AND phase = 'summarize' AND status != 'completed'`,
      )
      .run(now, runId);
  }

  markFailed(runId: string, ledger: RunLedger, error: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs SET run_status = 'failed', updated_at = ?, ledger_json = ? WHERE run_id = ?`,
      )
      .run(now, JSON.stringify(ledgerForStorage(ledger)), runId);
    const phase = ledger.phase;
    if (phase !== "done") {
      this.db
        .prepare(
          `UPDATE run_phases SET status = 'running', error = ? WHERE run_id = ? AND phase = ?`,
        )
        .run(error.slice(0, 2000), runId, phase);
    }
  }

  loadRun(runId: string): LoadedRun | null {
    const row = this.getRunRow(runId);
    if (!row) return null;
    const ledger = parseLedger(row.ledger_json);
    return {
      runId: row.run_id,
      sessionId: row.session_id || ledger.sessionId,
      repoPath: row.repo_path,
      bugDescription: row.bug_description,
      verifyMode: row.verify_mode as VerifyMode,
      url: row.url ?? undefined,
      model: row.model,
      reviewer: row.reviewer,
      maxCycles: row.max_cycles,
      runStatus: row.run_status as RunLifecycleStatus,
      nextPhase: row.next_phase as Phase,
      ledger,
    };
  }

  findLatestInterrupted(repoPath: string): string | null {
    const row = this.db
      .prepare(
        `SELECT run_id FROM runs
         WHERE repo_path = ? AND run_status IN ('interrupted', 'waiting_on_user')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(path.resolve(repoPath)) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }

  getPhaseTimeline(runId: string): PhaseTimelineRow[] {
    const rows = this.db
      .prepare(
        `SELECT phase, status, started_at, completed_at, error
         FROM run_phases WHERE run_id = ?
         ORDER BY rowid ASC`,
      )
      .all(runId) as Array<{
      phase: string;
      status: string;
      started_at: number | null;
      completed_at: number | null;
      error: string | null;
    }>;

    return rows.map((r) => ({
      phase: r.phase,
      status: r.status as PhaseRowStatus,
      startedAt: r.started_at ?? undefined,
      completedAt: r.completed_at ?? undefined,
      error: r.error ?? undefined,
    }));
  }

  listRuns(options: {
    repoPath?: string;
    runStatus?: RunLifecycleStatus | "all";
    limit?: number;
  }): RunListRow[] {
    const limit = options.limit ?? 20;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.repoPath) {
      conditions.push("repo_path = ?");
      params.push(path.resolve(options.repoPath));
    }
    if (options.runStatus && options.runStatus !== "all") {
      conditions.push("run_status = ?");
      params.push(options.runStatus);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT run_id, session_id, repo_path, bug_description, url, verify_mode,
                run_status, final_status, current_phase, next_phase, cycles,
                started_at, updated_at
         FROM runs ${where}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
      run_id: string;
      session_id: string;
      repo_path: string;
      bug_description: string;
      url: string | null;
      verify_mode: string;
      run_status: RunLifecycleStatus;
      final_status: string | null;
      current_phase: string;
      next_phase: string;
      cycles: number;
      started_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      runId: r.run_id,
      sessionId: r.session_id,
      repoPath: r.repo_path,
      bugDescription: r.bug_description,
      verifyMode: r.verify_mode as VerifyMode,
      url: r.url ?? undefined,
      runStatus: r.run_status,
      finalStatus:
        r.final_status === "fixed" ||
        r.final_status === "partial" ||
        r.final_status === "abandoned" ||
        r.final_status === "running"
          ? r.final_status
          : undefined,
      currentPhase: r.current_phase as Phase,
      nextPhase: r.next_phase as Phase,
      cycles: r.cycles,
      startedAt: r.started_at,
      updatedAt: r.updated_at,
    }));
  }

  private getRunRow(runId: string): RunRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM runs WHERE run_id = ?`)
        .get(runId) as RunRow | undefined) ?? null
    );
  }

  private updateRunRow(
    runId: string,
    patch: {
      sessionId?: string;
      currentPhase?: Phase;
      nextPhase?: Phase;
      cycles?: number;
      ledger: RunLedger;
    },
  ): void {
    const row = this.getRunRow(runId);
    if (!row) return;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs SET
          session_id = COALESCE(?, session_id),
          current_phase = COALESCE(?, current_phase),
          next_phase = COALESCE(?, next_phase),
          cycles = COALESCE(?, cycles),
          updated_at = ?,
          ledger_json = ?
        WHERE run_id = ?`,
      )
      .run(
        patch.sessionId ?? null,
        patch.currentPhase ?? null,
        patch.nextPhase ?? null,
        patch.cycles ?? null,
        now,
        JSON.stringify(ledgerForStorage(patch.ledger)),
        runId,
      );
  }

  close(): void {
    this.db.close();
  }
}

let storeSingleton: RunStore | null = null;

function assertSqliteSupported(): void {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1] ?? "0");
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(
      "Run state DB requires Node.js 22.5+ (built-in node:sqlite). Upgrade Node or use debug run --session for ACP-only resume.",
    );
  }
}

export function getRunStore(): RunStore {
  if (!storeSingleton) {
    assertSqliteSupported();
    fs.mkdirSync(path.dirname(STATE_DB_PATH), { recursive: true });
    const db = new DatabaseSync(STATE_DB_PATH);
    db.exec("PRAGMA foreign_keys = ON");
    storeSingleton = new RunStore(db);
  }
  return storeSingleton;
}

export function closeRunStore(): void {
  storeSingleton?.close();
  storeSingleton = null;
}
