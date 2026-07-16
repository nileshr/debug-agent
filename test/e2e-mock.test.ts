import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PROJECT_ROOT,
  makeE2eEnv,
  readLedger,
  readMockLog,
  runCli,
} from "./helpers.js";

const HAPPY_SCENARIO = path.join(PROJECT_ROOT, "test", "fixtures", "scenario-happy.json");

test("happy path: full loop against mock ACP agent ends fixed", async () => {
  const env = makeE2eEnv();
  try {
    const result = await runCli({
      env,
      scenario: HAPPY_SCENARIO,
      args: [
        "run",
        env.repo,
        "--bug",
        "pagination returns one extra item",
        "--no-open",
        "--no-config-prompt",
      ],
    });

    assert.equal(result.code, 0, `exit code 0 expected\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /finished: fixed/);

    const ledger = readLedger(env.repo);
    assert.equal(ledger.status, "fixed");
    assert.equal(ledger.confirmedHypothesisId, "H1");
    assert.equal(ledger.cycles, 1);
    assert.equal(ledger.reviewCycles, 1);
    assert.equal((ledger.summary as { rootCause: string }).rootCause, "slice(0, n + 1) off-by-one");
    assert.equal(ledger.sentinelCountAfter, 0);
    const hypotheses = ledger.hypotheses as Array<{ id: string; status: string }>;
    assert.equal(hypotheses[0]?.id, "H1");
    assert.equal(hypotheses[0]?.status, "confirmed");

    // Sentinel was really written then cleaned up in the repo.
    const buggy = fs.readFileSync(path.join(env.repo, "src", "buggy.js"), "utf8");
    assert.ok(!buggy.includes("DEBUG-INSTRUMENT"), "sentinel removed after mark_fixed");
    assert.match(buggy, /items\.slice\(0, n\)/);

    // Mode switching: plan for hypothesize, then agent for instrument.
    const modeValues = readMockLog(env)
      .filter(
        (e) =>
          e.method === "session/set_config_option" &&
          (e.params as { configId?: string }).configId === "mode",
      )
      .map((e) => (e.params as { value: string }).value);
    assert.deepEqual(modeValues, ["plan", "agent"]);

    // Model switching happened per role (planner → fixer → reviewer → fixer).
    const modelValues = readMockLog(env)
      .filter(
        (e) =>
          e.method === "session/set_config_option" &&
          (e.params as { configId?: string }).configId === "model",
      )
      .map((e) => (e.params as { value: string }).value);
    assert.ok(modelValues.length >= 3, `expected role model switches, got ${JSON.stringify(modelValues)}`);

    // State DB has the run completed with the expected phases executed.
    const db = new DatabaseSync(path.join(env.home, ".debug-agent", "state.db"), { readOnly: true });
    try {
      const run = db
        .prepare("SELECT run_status FROM runs WHERE run_id = ?")
        .get(ledger.runId as string) as { run_status: string } | undefined;
      assert.equal(run?.run_status, "completed");
      const rows = db
        .prepare("SELECT phase, status FROM run_phases WHERE run_id = ?")
        .all(ledger.runId as string) as Array<{ phase: string; status: string }>;
      const byPhase = Object.fromEntries(rows.map((r) => [r.phase, r.status]));
      for (const phase of [
        "hypothesize",
        "instrument",
        "reproduce",
        "analyze",
        "apply_fix",
        "verify",
        "mark_fixed",
        "review",
        "summarize",
      ]) {
        assert.equal(byPhase[phase], "completed", `phase ${phase} should be completed`);
      }
      assert.notEqual(byPhase["apply_review"], "completed", "apply_review not executed on happy path");
    } finally {
      db.close();
    }
  } finally {
    env.cleanup();
  }
});
