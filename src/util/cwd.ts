import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** True when the directory exists and is readable/writable/executable. */
export function isDirectoryAccessible(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** process.cwd() without throwing when the shell cwd is inaccessible. */
export function tryProcessCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/**
 * Pick a cwd for spawning child processes. Prefers `preferred` (e.g. --repo),
 * then the process cwd, then $HOME, then the system temp dir.
 */
export function resolveSpawnCwd(preferred?: string): string {
  const candidates = [
    preferred ? path.resolve(preferred) : undefined,
    tryProcessCwd() ?? undefined,
    os.homedir(),
    os.tmpdir(),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  for (const dir of candidates) {
    if (isDirectoryAccessible(dir)) return dir;
  }
  return os.tmpdir();
}
