import { emitHtmlReport } from "../dist/report/emit.js";

const mockReport = {
  runId: "smoke01",
  sessionId: "test-session",
  repoPath: "/tmp/demo-repo",
  verifyMode: "browser",
  url: "http://localhost:3000",
  bugDescription: "Save button shows blank modal",
  status: "fixed",
  model: "composer-2.5[fast=true]",
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  elapsedMs: 45000,
  cycles: 1,
  hypotheses: [
    {
      id: "H1",
      rank: 1,
      statement: "Modal state not cleared before open",
      file: "src/Modal.tsx",
      line: 42,
      status: "confirmed",
    },
  ],
  instrumentation: {
    filesTouched: ["src/Modal.tsx"],
    sentinelCountBefore: 3,
    sentinelCountAfter: 0,
  },
  reproduction: {
    mode: "browser",
    url: "http://localhost:3000",
    steps: ["Open app", "Click Save", "Observe blank modal"],
    logEntries: [{ hypothesis: "H1", value: { open: false } }],
  },
  fix: {
    diffStat: "1 file, +2 -1",
    rootCause: "Modal opened before data loaded",
    explanation: "Gate open on isReady flag",
  },
  review: { comments: [] },
  summary: {
    bugSummary: "Save button shows blank modal",
    rootCause: "Modal opened before data loaded",
    fixExplanation: "Added isReady guard before setOpen(true)",
    risks: [],
    followUps: ["Add e2e test for save flow"],
  },
  session: {
    sessionId: "test-session",
    resumed: false,
    debugResumeCommand:
      'debug run "/tmp/demo-repo" --session test-session --bug "Save button shows blank modal" --url "http://localhost:3000"',
    agentResumeCommand: "agent --resume test-session",
  },
  trace: [
    {
      ts: Date.now() - 40_000,
      phase: "hypothesize",
      kind: "phase",
      text: "Started hypothesize",
    },
    {
      ts: Date.now() - 38_000,
      phase: "hypothesize",
      kind: "message",
      text: "Investigating Modal.tsx open handler and save flow state",
    },
    {
      ts: Date.now() - 35_000,
      phase: "hypothesize",
      kind: "todo",
      text: "Rank hypotheses for blank modal on save",
    },
    {
      ts: Date.now() - 20_000,
      phase: "instrument",
      kind: "tool",
      text: "StrReplace",
    },
    {
      ts: Date.now() - 18_000,
      phase: "instrument",
      kind: "message",
      text: "Adding JSONL instrumentation around setOpen and isReady",
    },
    {
      ts: Date.now() - 5_000,
      phase: "apply_fix",
      kind: "message",
      text: "Gate modal open on isReady flag after save response",
    },
  ],
};

const path = await emitHtmlReport(mockReport, { open: false });
console.log("Smoke OK:", path);
