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
};

const path = await emitHtmlReport(mockReport, { open: false });
console.log("Smoke OK:", path);
