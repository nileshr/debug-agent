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
const RETRY_SCENARIO = path.join(PROJECT_ROOT, "test", "fixtures", "scenario-retry.json");

function readStepSequence(home: string, runId: string): string[] {
  const db = new DatabaseSync(path.join(home, ".debug-agent", "state.db"), {
    readOnly: true,
  });
  try {
    const rows = db
      .prepare("SELECT step_id FROM run_steps WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as Array<{ step_id: string }>;
    return rows.map((r) => r.step_id);
  } finally {
    db.close();
  }
}

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

    // Exact executed-step sequence from the v2 run_steps table.
    assert.deepEqual(readStepSequence(env.home, ledger.runId as string), [
      "hypothesize",
      "instrument",
      "reproduce",
      "analyze",
      "apply_fix",
      "verify",
      "mark_fixed",
      "review",
      "re_verify",
      "summarize",
    ]);

    // Every transition was recorded as an auditable static decision.
    const decisions = ledger.decisions as Array<{ decidedBy: string; action: string }>;
    assert.ok(decisions.length >= 10, `expected decision log, got ${decisions?.length}`);
    assert.ok(decisions.every((d) => d.decidedBy === "static"));
  } finally {
    env.cleanup();
  }
});

test("standard ACP agent (claude preset): auth negotiation, set_mode, plan updates", async () => {
  const env = makeE2eEnv();
  const STANDARD_SCENARIO = path.join(
    PROJECT_ROOT,
    "test",
    "fixtures",
    "scenario-standard.json",
  );
  try {
    const result = await runCli({
      env,
      scenario: STANDARD_SCENARIO,
      args: [
        "run",
        env.repo,
        "--bug",
        "pagination returns one extra item",
        "--agent",
        "claude",
        "--no-open",
        "--no-config-prompt",
      ],
    });
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /finished: fixed/);

    const ledger = readLedger(env.repo);
    assert.equal(ledger.status, "fixed");
    assert.equal(ledger.agentPreset, "claude");

    const log = readMockLog(env);
    const methods = log.map((e) => e.method);

    // On-demand auth: session/new attempted, rejected, authenticate with the
    // advertised method, then session/new again.
    const firstNew = methods.indexOf("session/new");
    const authIdx = methods.indexOf("authenticate");
    assert.ok(firstNew >= 0 && authIdx > firstNew, "authenticate follows failed session/new");
    assert.equal(
      (log[authIdx].params as { methodId: string }).methodId,
      "api_key",
      "uses the advertised auth method",
    );
    assert.equal(methods.lastIndexOf("session/new") > authIdx, true);

    // Official transport: session/set_mode used, Cursor set_config_option never.
    assert.ok(!methods.includes("session/set_config_option"));
    const modeIds = log
      .filter((e) => e.method === "session/set_mode")
      .map((e) => (e.params as { modeId: string }).modeId);
    assert.deepEqual(modeIds, ["plan", "default"], "plan for hypothesize, default for execute");

    // Cursor model ids are not offered by this agent → no set_model attempts.
    assert.ok(!methods.includes("session/set_model"));

    // Todos arrived via the standard ACP plan update.
    const todos = ledger.todos as Array<{ content: string }>;
    assert.equal(todos.length, 1);
    assert.match(todos[0].content, /Off-by-one/);

    // No cursor extension traffic from the mock in standard mode.
    assert.ok(!methods.some((m) => m.startsWith("cursor/")));
  } finally {
    env.cleanup();
  }
});

test("retry path: failed verify loops through analyze and apply_fix again", async () => {
  const env = makeE2eEnv();
  try {
    const result = await runCli({
      env,
      scenario: RETRY_SCENARIO,
      args: [
        "run",
        env.repo,
        "--bug",
        "pagination returns one extra item",
        "--no-open",
        "--no-config-prompt",
      ],
    });
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const ledger = readLedger(env.repo);
    assert.equal(ledger.status, "fixed");
    assert.equal(ledger.cycles, 2, "two verify cycles");
    assert.deepEqual(readStepSequence(env.home, ledger.runId as string), [
      "hypothesize",
      "instrument",
      "reproduce",
      "analyze",
      "apply_fix",
      "verify",
      "analyze",
      "apply_fix",
      "verify",
      "mark_fixed",
      "review",
      "re_verify",
      "summarize",
    ]);
  } finally {
    env.cleanup();
  }
});

test("resume: interrupted run continues from next step via session/load", async () => {
  const env = makeE2eEnv();
  try {
    const first = await runCli({
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
    assert.equal(first.code, 0);
    const ledger = readLedger(env.repo);
    const runId = ledger.runId as string;

    // Rewind the run to an interrupted state poised before review.
    const dbPath = path.join(env.home, ".debug-agent", "state.db");
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "UPDATE runs SET run_status = 'interrupted', final_status = NULL, next_phase = 'review' WHERE run_id = ?",
    ).run(runId);
    db.close();

    const resumed = await runCli({
      env,
      scenario: HAPPY_SCENARIO,
      args: ["resume", env.repo, "--run", runId, "--no-open", "--no-report"],
    });
    assert.equal(resumed.code, 0, `stdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`);
    assert.match(resumed.stdout, /finished: fixed/);

    // The resumed portion appended to the same step history.
    const seq = readStepSequence(env.home, runId);
    assert.deepEqual(seq.slice(-3), ["review", "re_verify", "summarize"]);

    // session/load was used instead of session/new on resume.
    const methods = readMockLog(env).map((e) => e.method);
    assert.ok(methods.includes("session/load"), "resume used session/load");
  } finally {
    env.cleanup();
  }
});
