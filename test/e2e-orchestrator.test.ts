import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROJECT_ROOT, makeE2eEnv, readLedger, runCli } from "./helpers.js";

const FIXTURES = path.join(PROJECT_ROOT, "test", "fixtures");
const BUG = "pagination returns one extra item";

function stepSeq(home: string, runId: string): string[] {
  const db = new DatabaseSync(path.join(home, ".debug-agent", "state.db"), {
    readOnly: true,
  });
  try {
    return (
      db
        .prepare("SELECT step_id FROM run_steps WHERE run_id = ? ORDER BY seq ASC")
        .all(runId) as Array<{ step_id: string }>
    ).map((r) => r.step_id);
  } finally {
    db.close();
  }
}

test("guided: happy path takes the heuristic fast path (same steps as static)", async () => {
  const env = makeE2eEnv();
  try {
    const result = await runCli({
      env,
      scenario: path.join(FIXTURES, "scenario-happy.json"),
      args: ["run", env.repo, "--bug", BUG, "--autonomy", "guided", "--no-open", "--no-config-prompt"],
    });
    assert.equal(result.code, 0, result.stderr);

    const ledger = readLedger(env.repo);
    assert.equal(ledger.status, "fixed");
    assert.deepEqual(stepSeq(env.home, ledger.runId as string), [
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
    const decisions = ledger.decisions as Array<{ decidedBy: string }>;
    assert.ok(decisions.every((d) => d.decidedBy === "heuristic"));
  } finally {
    env.cleanup();
  }
});

test("guided: unparsable verify reply is retried once with an addendum", async () => {
  const env = makeE2eEnv();
  try {
    const result = await runCli({
      env,
      scenario: path.join(FIXTURES, "scenario-guided-retry.json"),
      args: ["run", env.repo, "--bug", BUG, "--autonomy", "guided", "--no-open", "--no-config-prompt"],
    });
    assert.equal(result.code, 0, result.stderr);

    const ledger = readLedger(env.repo);
    assert.equal(ledger.status, "fixed");
    assert.equal(ledger.cycles, 2, "verify prompted twice (retry)");
    const seq = stepSeq(env.home, ledger.runId as string);
    assert.deepEqual(seq.slice(4, 7), ["apply_fix", "verify", "verify"]);

    const decisions = ledger.decisions as Array<{
      action: string;
      decidedBy: string;
      afterStep: string;
    }>;
    const retry = decisions.find((d) => d.action === "retry");
    assert.ok(retry, "a retry decision was recorded");
    assert.equal(retry?.decidedBy, "heuristic");
    assert.equal(retry?.afterStep, "verify");
  } finally {
    env.cleanup();
  }
});

test("guided: inconclusive analysis inserts explore, then pauses with questions (exit 3) and resumes with --answer", async () => {
  const env = makeE2eEnv();
  try {
    const scenario = path.join(FIXTURES, "scenario-guided-askuser.json");
    const first = await runCli({
      env,
      scenario,
      args: ["run", env.repo, "--bug", BUG, "--autonomy", "guided", "--no-open", "--no-config-prompt"],
    });
    assert.equal(first.code, 3, `expected exit 3\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    assert.match(first.stdout, /needs your input/);

    const ledger = readLedger(env.repo);
    const runId = ledger.runId as string;
    const pending = ledger.pendingQuestions as Array<{ id: string }>;
    assert.equal(pending.length, 2);

    // The dynamic detour: analyze → (insert) explore → back to analyze.
    const seq = stepSeq(env.home, runId);
    assert.deepEqual(seq.slice(3), ["analyze", "explore", "analyze"]);
    const history = ledger.stepHistory as Array<{ stepId: string; inserted?: boolean }>;
    assert.ok(history.find((s) => s.stepId === "explore")?.inserted, "explore marked inserted");

    const db = new DatabaseSync(path.join(env.home, ".debug-agent", "state.db"), { readOnly: true });
    const row = db
      .prepare("SELECT run_status, next_phase FROM runs WHERE run_id = ?")
      .get(runId) as { run_status: string; next_phase: string };
    db.close();
    assert.equal(row.run_status, "waiting_on_user");
    assert.equal(row.next_phase, "apply_fix");

    // Resume with answers → run completes.
    const resumed = await runCli({
      env,
      scenario,
      args: [
        "resume",
        env.repo,
        "--run",
        runId,
        "--answer",
        "The list shows one extra row after clicking next page.",
        "--answer",
        "Run node repro.js with n=2.",
        "--no-open",
        "--no-report",
      ],
    });
    assert.equal(resumed.code, 0, `stdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`);
    assert.match(resumed.stdout, /finished: fixed/);

    const finalLedger = readLedger(env.repo);
    assert.equal(finalLedger.status, "fixed");
    assert.equal((finalLedger.userAnswers as unknown[]).length, 2);
    assert.equal(finalLedger.pendingQuestions, undefined);
  } finally {
    env.cleanup();
  }
});

test("autonomous: LLM decisions via oneShot; guardrails veto illegal skips, legal skip works", async () => {
  const env = makeE2eEnv();
  try {
    const result = await runCli({
      env,
      scenario: path.join(FIXTURES, "scenario-autonomous.json"),
      args: [
        "run",
        env.repo,
        "--bug",
        BUG,
        "--autonomy",
        "autonomous",
        "--orchestrator-model",
        "mock-model",
        "--no-open",
        "--no-config-prompt",
      ],
    });
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const ledger = readLedger(env.repo);
    assert.equal(ledger.status, "fixed");

    // The orchestrator's constant "skip_to summarize" is vetoed until it
    // becomes legal after mark_fixed — so review/re_verify are skipped.
    assert.deepEqual(stepSeq(env.home, ledger.runId as string), [
      "hypothesize",
      "instrument",
      "reproduce",
      "analyze",
      "apply_fix",
      "verify",
      "mark_fixed",
      "summarize",
    ]);

    const decisions = ledger.decisions as Array<{
      decidedBy: string;
      action: string;
      overridden?: { reason: string };
    }>;
    assert.ok(
      decisions.some((d) => d.decidedBy === "guardrail_override" && d.overridden),
      "illegal LLM decisions were vetoed and recorded",
    );
    assert.ok(
      decisions.some((d) => d.decidedBy === "llm" && d.action === "skip_to"),
      "the legal LLM skip was honored",
    );
  } finally {
    env.cleanup();
  }
});
