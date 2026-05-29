import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoConfigPath } from "../debug/repo-paths.js";

export { repoConfigPath };

export const CONFIG_DIR = path.join(os.homedir(), ".debug-agent");
export const GLOBAL_CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function hasGlobalConfig(): boolean {
  return fs.existsSync(GLOBAL_CONFIG_PATH);
}

export function hasRepoConfig(repoPath: string): boolean {
  return fs.existsSync(repoConfigPath(repoPath));
}

export function hasAnyAgentConfig(repoPath?: string): boolean {
  if (hasGlobalConfig()) return true;
  if (repoPath && hasRepoConfig(repoPath)) return true;
  return false;
}
