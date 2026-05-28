import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const DebugLogEntrySchema = z.object({
  hypothesis: z.string(),
  file: z.string(),
  line: z.number().optional(),
  value: z.unknown().optional(),
  ts: z.number().optional(),
});

export type DebugLogEntry = z.infer<typeof DebugLogEntrySchema>;

export function debugLogPath(repoPath: string): string {
  return path.join(repoPath, ".cursor", "debug.log");
}

export function readDebugLogSince(
  repoPath: string,
  sinceTs = 0,
): DebugLogEntry[] {
  const logPath = debugLogPath(repoPath);
  if (!fs.existsSync(logPath)) return [];

  const content = fs.readFileSync(logPath, "utf8");
  const entries: DebugLogEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = DebugLogEntrySchema.parse(JSON.parse(trimmed));
      if ((parsed.ts ?? 0) >= sinceTs) {
        entries.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

export function groupByHypothesis(
  entries: DebugLogEntry[],
): Record<string, DebugLogEntry[]> {
  const groups: Record<string, DebugLogEntry[]> = {};
  for (const entry of entries) {
    const key = entry.hypothesis;
    if (!groups[key]) groups[key] = [];
    groups[key].push(entry);
  }
  return groups;
}

export interface WaitForLogOptions {
  repoPath: string;
  sinceTs?: number;
  minEntries?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Poll `.cursor/debug.log` until minEntries or timeout. */
export async function waitForDebugLog(
  options: WaitForLogOptions,
): Promise<DebugLogEntry[]> {
  const {
    repoPath,
    sinceTs = 0,
    minEntries = 1,
    timeoutMs = 120_000,
    pollIntervalMs = 500,
  } = options;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = readDebugLogSince(repoPath, sinceTs);
    if (entries.length >= minEntries) {
      return entries;
    }
    await sleep(pollIntervalMs);
  }

  return readDebugLogSince(repoPath, sinceTs);
}

export function countSentinels(repoPath: string, runId: string): number {
  const sentinel = `DEBUG-INSTRUMENT:${runId}`;
  let count = 0;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") {
        continue;
      }
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        try {
          const text = fs.readFileSync(full, "utf8");
          const matches = text.split(sentinel).length - 1;
          if (matches > 0) count += matches;
        } catch {
          // binary or unreadable
        }
      }
    }
  }

  walk(repoPath);
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
