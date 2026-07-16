import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunStore } from "../src/debug/run-store.js";

/** Create a pre-v2 state DB shaped like the legacy schema, with one run. */
function seedV1Db(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE runs (
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
    CREATE TABLE run_phases (
      run_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      PRIMARY KEY (run_id, phase)
    );
  `);
  const ledger = {
    runId: "old1",
    sessionId: "sess-old",
    sessionResumed: false,
    repoPath: "/tmp/legacy",
    verifyMode: "cli",
    bugDescription: "legacy bug",
    model: "m",
    reviewer: "r",
    startedAt: 1,
    phase: "analyze",
    cycles: 1,
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
  db.prepare(
    `INSERT INTO runs VALUES (?, ?, ?, ?, NULL, 'cli', 'm', 'r', 5, 'interrupted', NULL, 'analyze', 'analyze', 1, 1, 1, ?)`,
  ).run("old1", "sess-old", "/tmp/legacy", "legacy bug", JSON.stringify(ledger));
  const phases: Array<[string, string]> = [
    ["hypothesize", "completed"],
    ["instrument", "completed"],
    ["reproduce", "completed"],
    ["analyze", "running"],
    ["apply_fix", "pending"],
    ["verify", "pending"],
  ];
  for (const [phase, status] of phases) {
    db.prepare(`INSERT INTO run_phases (run_id, phase, status) VALUES (?, ?, ?)`).run(
      "old1",
      phase,
      status,
    );
  }
  db.close();
}

test("v1 → v2 migration creates tables, columns, and seeds run_steps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-store-"));
  const file = path.join(dir, "state.db");
  try {
    seedV1Db(file);

    const store = new RunStore(new DatabaseSync(file));
    // Executed portion of run_phases was copied in order.
    const steps = store.getStepTimeline("old1");
    assert.deepEqual(
      steps.map((s) => [s.stepId, s.status]),
      [
        ["hypothesize", "completed"],
        ["instrument", "completed"],
        ["reproduce", "completed"],
        ["analyze", "running"],
      ],
    );

    // Upgrade-on-read fills v2 ledger fields.
    const loaded = store.loadRun("old1");
    assert.ok(loaded);
    assert.equal(loaded.ledger.runtime, "acp");
    assert.equal(loaded.ledger.agentPreset, "cursor");
    assert.equal(loaded.ledger.autonomy, "static");
    assert.deepEqual(loaded.ledger.stepHistory, []);
    assert.deepEqual(loaded.ledger.decisions, []);
    assert.equal(loaded.nextPhase, "analyze");

    // New appends continue after the migrated rows.
    const seq = store.beginStep("old1", "analyze", 2);
    assert.equal(seq, 5);
    store.completeStep("old1", seq, "completed", "json_extraction");
    store.close();

    const db = new DatabaseSync(file, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.equal(version.user_version, 2);
    const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const col of ["runtime", "agent_preset", "autonomy", "resume_token"]) {
      assert.ok(names.includes(col), `runs.${col} exists`);
    }
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migration is idempotent across reopens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-store-"));
  const file = path.join(dir, "state.db");
  try {
    seedV1Db(file);
    new RunStore(new DatabaseSync(file)).close();
    const store = new RunStore(new DatabaseSync(file));
    assert.equal(store.getStepTimeline("old1").length, 4);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
