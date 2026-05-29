import path from "node:path";

/** Repo-local debug-agent directory (config, logs, run ledgers). */
export const REPO_DEBUG_AGENT_DIR = ".debug-agent";

export function repoDebugAgentDir(repoPath: string): string {
  return path.join(path.resolve(repoPath), REPO_DEBUG_AGENT_DIR);
}

/** Repo override merged over `~/.debug-agent/config.json`. */
export function repoConfigPath(repoPath: string): string {
  return path.join(repoDebugAgentDir(repoPath), "config.json");
}

export function debugLogPath(repoPath: string): string {
  return path.join(repoDebugAgentDir(repoPath), "debug.log");
}

export function debugRunsDir(repoPath: string): string {
  return path.join(repoDebugAgentDir(repoPath), "debug-runs");
}

export function debugRunLedgerPath(repoPath: string, runId: string): string {
  return path.join(debugRunsDir(repoPath), `${runId}.json`);
}
