export interface SessionResumeHints {
  sessionId: string;
  repoPath: string;
  bugDescription: string;
  url?: string;
  /** When set, prefer phase-aware resume via `debug resume`. */
  runId?: string;
}

export function formatDebugResumeCommand(hints: SessionResumeHints): string {
  if (hints.runId) {
    return [
      "debug",
      "resume",
      JSON.stringify(hints.repoPath),
      "--run",
      hints.runId,
    ].join(" ");
  }
  const parts = [
    "debug",
    "run",
    JSON.stringify(hints.repoPath),
    "--session",
    hints.sessionId,
    "--bug",
    JSON.stringify(hints.bugDescription),
  ];
  if (hints.url) {
    parts.push("--url", JSON.stringify(hints.url));
  }
  return parts.join(" ");
}

export function formatAgentResumeCommand(sessionId: string): string {
  return `agent --resume ${sessionId}`;
}
