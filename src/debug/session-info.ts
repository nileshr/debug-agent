export interface SessionResumeHints {
  sessionId: string;
  repoPath: string;
  bugDescription: string;
  url?: string;
}

export function formatDebugResumeCommand(hints: SessionResumeHints): string {
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
