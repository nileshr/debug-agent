import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStepPolicy, DONE, type TransitionContext } from "../src/engine/policy.js";
import type { EngineScratch } from "../src/engine/catalog.js";
import type { RunLedger } from "../src/debug/types.js";

function makeLedger(overrides: Partial<RunLedger> = {}): RunLedger {
  return {
    runId: "t1",
    sessionId: "s1",
    sessionResumed: false,
    repoPath: "/tmp/x",
    verifyMode: "cli",
    bugDescription: "bug",
    model: "m",
    plannerModel: "p",
    reviewer: "r",
    startedAt: 0,
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
    ...overrides,
  };
}

function makeCtx(options: {
  ledger?: Partial<RunLedger>;
  lastData?: unknown;
  sentinels?: number;
  state?: Partial<EngineScratch>;
  maxCycles?: number;
}): TransitionContext {
  const state: EngineScratch = {
    markFixedNext: "review",
    markFixedRetries: 0,
    logSinceTs: 0,
    ...options.state,
  };
  return {
    ledger: makeLedger(options.ledger),
    maxCycles: options.maxCycles ?? 5,
    state,
    remainingSentinels: () => options.sentinels ?? 0,
    log: () => {},
    warn: () => {},
    lastData: options.lastData ?? null,
  };
}

const policy = buildStepPolicy({ maxCycles: 5 });
const next = (step: string, ctx: TransitionContext) =>
  policy.defaultNext[step](ctx);

test("linear chain matches the historical switch", () => {
  assert.equal(next("hypothesize", makeCtx({})), "instrument");
  assert.equal(next("instrument", makeCtx({})), "reproduce");
  assert.equal(next("reproduce", makeCtx({})), "analyze");
  assert.equal(next("analyze", makeCtx({})), "apply_fix");
  assert.equal(next("apply_fix", makeCtx({})), "verify");
});

test("verify: verified goes to mark_fixed with review queued", () => {
  const ctx = makeCtx({ ledger: { cycles: 1 }, lastData: { verified: true } });
  assert.equal(next("verify", ctx), "mark_fixed");
  assert.equal(ctx.state.markFixedNext, "review");
  assert.equal(ctx.ledger.status, "running");
});

test("verify: not verified under budget loops to analyze", () => {
  const ctx = makeCtx({ ledger: { cycles: 1 }, lastData: { verified: false } });
  assert.equal(next("verify", ctx), "analyze");
});

test("verify: budget exhausted goes partial and proceeds", () => {
  const ctx = makeCtx({ ledger: { cycles: 5 }, lastData: { verified: false } });
  assert.equal(next("verify", ctx), "mark_fixed");
  assert.equal(ctx.ledger.status, "partial");
});

test("mark_fixed: retries while sentinels remain, then gives up to markFixedNext", () => {
  const ctx = makeCtx({ ledger: { sentinelCountAfter: 2 } });
  assert.equal(next("mark_fixed", ctx), "mark_fixed");
  assert.equal(ctx.state.markFixedRetries, 1);
  assert.equal(next("mark_fixed", ctx), "mark_fixed");
  assert.equal(ctx.state.markFixedRetries, 2);
  // Third attempt exhausts retries and proceeds despite sentinels.
  assert.equal(next("mark_fixed", ctx), "review");
  assert.equal(ctx.state.markFixedRetries, 0);
});

test("mark_fixed: clean goes straight to markFixedNext", () => {
  const ctx = makeCtx({
    ledger: { sentinelCountAfter: 0 },
    state: { markFixedNext: "summarize" },
  });
  assert.equal(next("mark_fixed", ctx), "summarize");
});

test("review: comments branch to apply_review, none to re_verify", () => {
  const withComments = makeCtx({
    ledger: { reviewComments: [{ id: "C1", text: "x", addressed: false }] },
  });
  assert.equal(next("review", withComments), "apply_review");
  assert.equal(next("review", makeCtx({})), "re_verify");
});

test("re_verify: unverified with unaddressed comments loops to apply_review", () => {
  const ctx = makeCtx({
    ledger: { reviewComments: [{ id: "C1", text: "x", addressed: false }] },
    lastData: { verified: false },
  });
  assert.equal(next("re_verify", ctx), "apply_review");
});

test("re_verify: verified goes to summarize (or mark_fixed when dirty)", () => {
  const clean = makeCtx({ lastData: { verified: true } });
  assert.equal(next("re_verify", clean), "summarize");
  assert.equal(clean.state.markFixedNext, "summarize");

  const dirty = makeCtx({ lastData: { verified: true }, sentinels: 1 });
  assert.equal(next("re_verify", dirty), "mark_fixed");
});

test("summarize: finishes and sets final status", () => {
  const ok = makeCtx({});
  assert.equal(next("summarize", ok), DONE);
  assert.equal(ok.ledger.status, "fixed");

  const partial = makeCtx({ ledger: { status: "partial" } });
  assert.equal(next("summarize", partial), DONE);
  assert.equal(partial.ledger.status, "partial");
});
