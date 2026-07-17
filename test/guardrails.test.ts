import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGuardrails, type GuardrailInput } from "../src/engine/guardrails.js";
import { buildStepCatalog } from "../src/engine/catalog.js";
import { buildStepPolicy, type TransitionContext } from "../src/engine/policy.js";
import { Orchestrator, type OrchestratorInput } from "../src/engine/orchestrator.js";
import type { StepDefinition } from "../src/engine/catalog.js";
import type { RunLedger } from "../src/debug/types.js";
import type { AgentRuntime, StepPromptResult } from "../src/runtime/types.js";

const catalog = buildStepCatalog();
const policy = buildStepPolicy({ maxCycles: 5 });
const catalogIds = new Set(catalog.keys());

function ledgerStub(overrides: Partial<RunLedger> = {}): RunLedger {
  return {
    runId: "t",
    sessionId: "s",
    sessionResumed: false,
    repoPath: "/tmp/x",
    verifyMode: "cli",
    bugDescription: "bug",
    model: "m",
    plannerModel: "p",
    reviewer: "r",
    startedAt: 0,
    phase: "verify",
    cycles: 1,
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
    stepHistory: [],
    decisions: [],
    ...overrides,
  };
}

function ctxFor(step: string, ledger: RunLedger, lastData: unknown = null): TransitionContext {
  return {
    ledger,
    maxCycles: 5,
    state: { markFixedNext: "review", markFixedRetries: 0, logSinceTs: 0 },
    remainingSentinels: () => 0,
    log: () => {},
    warn: () => {},
    lastData,
  };
}

function guardInput(stepId: string, overrides: Partial<GuardrailInput> = {}): GuardrailInput {
  const ledger = ledgerStub({ phase: stepId as RunLedger["phase"] });
  return {
    step: catalog.get(stepId) as StepDefinition,
    policy,
    ctx: ctxFor(stepId, ledger, { verified: true }),
    attempt: 1,
    insertedCount: 0,
    catalogIds,
    ...overrides,
  };
}

test("guardrails veto skipping verify from apply_fix", () => {
  const result = applyGuardrails(guardInput("apply_fix"), {
    action: "skip_to",
    nextStepId: "summarize",
    rationale: "trivial fix, skip everything",
  });
  assert.ok(result.overridden, "decision was vetoed");
  assert.equal(result.decision.action, "advance");
  assert.equal(
    (result.decision as { nextStepId: string }).nextStepId,
    "verify",
    "falls back to the static transition",
  );
});

test("guardrails veto out-of-menu advance and unknown steps", () => {
  const bad = applyGuardrails(guardInput("hypothesize"), {
    action: "advance",
    nextStepId: "summarize",
    rationale: "skip ahead",
  });
  assert.ok(bad.overridden);

  const unknown = applyGuardrails(guardInput("analyze"), {
    action: "insert",
    stepId: "meditate",
    rationale: "?",
  });
  assert.ok(unknown.overridden);
});

test("guardrails enforce retry and insert budgets", () => {
  const retry = applyGuardrails(guardInput("analyze", { attempt: 2 }), {
    action: "retry",
    rationale: "try again",
  });
  assert.ok(retry.overridden, "retry vetoed at attempt cap");

  const insert = applyGuardrails(guardInput("analyze", { insertedCount: 4 }), {
    action: "insert",
    stepId: "explore",
    rationale: "more exploring",
  });
  assert.ok(insert.overridden, "insert vetoed at budget");
});

test("guardrails pass legal decisions through untouched", () => {
  const ok = applyGuardrails(guardInput("verify"), {
    action: "advance",
    nextStepId: "mark_fixed",
    rationale: "verified",
  });
  assert.equal(ok.overridden, undefined);
  assert.equal(ok.decision.action, "advance");

  const legalInsert = applyGuardrails(guardInput("analyze"), {
    action: "insert",
    stepId: "explore",
    rationale: "gather evidence",
  });
  assert.equal(legalInsert.overridden, undefined);
});

// ---- Orchestrator heuristics ----

const fakeRuntime = {
  kind: "acp",
  capabilities: () => ({ oneShot: false }),
} as unknown as AgentRuntime;

function orch(): Orchestrator {
  return new Orchestrator({
    autonomy: "guided",
    policy,
    runtime: fakeRuntime,
    repoPath: "/tmp/x",
  });
}

function orchInput(
  stepId: string,
  result: Partial<StepPromptResult>,
  ledger: RunLedger,
  extras: Partial<OrchestratorInput> = {},
): OrchestratorInput {
  return {
    stepJustRan: catalog.get(stepId) as StepDefinition,
    attempt: 1,
    result: {
      stopReason: "end_turn",
      data: null,
      dataSource: "none",
      rawText: "",
      ...result,
    },
    ctx: ctxFor(stepId, ledger, result.data ?? null),
    insertedCount: 0,
    totalSteps: 5,
    ...extras,
  };
}

test("heuristic: unparsable result retries with an addendum", async () => {
  const outcome = await orch().decide(
    orchInput("verify", { dataSource: "none", data: null }, ledgerStub()),
  );
  assert.equal(outcome.decidedBy, "heuristic");
  assert.equal(outcome.decision.action, "retry");
  assert.match(
    (outcome.decision as { promptAddendum?: string }).promptAddendum ?? "",
    /json/i,
  );
});

test("heuristic: inconclusive analyze inserts explore once, then asks the user", async () => {
  const ledger = ledgerStub({ confirmedHypothesisId: undefined });
  const first = await orch().decide(
    orchInput("analyze", { dataSource: "json_extraction", data: {} }, ledger),
  );
  assert.equal(first.decision.action, "insert");
  assert.equal((first.decision as { stepId: string }).stepId, "explore");

  const explored = ledgerStub({
    stepHistory: [
      { seq: 1, stepId: "explore", attempt: 1, startedAt: 0, inserted: true },
    ],
  });
  const second = await orch().decide(
    orchInput("analyze", { dataSource: "json_extraction", data: {} }, explored),
  );
  assert.equal(second.decision.action, "ask_user");
  assert.ok((second.decision as { questions: unknown[] }).questions.length >= 1);
});

test("heuristic: clean verify pass takes the static fast path", async () => {
  const ledger = ledgerStub({ confirmedHypothesisId: "H1", cycles: 1 });
  const outcome = await orch().decide(
    orchInput(
      "verify",
      { dataSource: "json_extraction", data: { verified: true } },
      ledger,
    ),
  );
  assert.equal(outcome.decidedBy, "heuristic");
  assert.equal(outcome.decision.action, "advance");
  assert.equal((outcome.decision as { nextStepId: string }).nextStepId, "mark_fixed");
});

test("heuristic: review-loop budget exhaustion finishes as partial", async () => {
  const ledger = ledgerStub({
    reviewCycles: 3,
    reviewComments: [{ id: "C1", text: "x", addressed: false }],
  });
  const outcome = await orch().decide(
    orchInput(
      "re_verify",
      { dataSource: "json_extraction", data: { verified: false } },
      ledger,
    ),
  );
  assert.equal(outcome.decision.action, "skip_to");
  assert.equal((outcome.decision as { nextStepId: string }).nextStepId, "summarize");
  assert.equal(ledger.status, "partial");
});
