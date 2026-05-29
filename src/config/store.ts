import fs from "node:fs";
import path from "node:path";
import { AgentConfigSchema, type AgentConfig } from "./types.js";
import { CONFIG_DIR, GLOBAL_CONFIG_PATH, repoConfigPath } from "./paths.js";

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readConfigFile(filePath: string): AgentConfig | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return AgentConfigSchema.parse(raw);
  } catch (err) {
    throw new Error(`Invalid agent config ${filePath}: ${(err as Error).message}`);
  }
}

export function loadGlobalConfig(): AgentConfig | null {
  return readConfigFile(GLOBAL_CONFIG_PATH);
}

export function loadRepoConfig(repoPath: string): AgentConfig | null {
  return readConfigFile(repoConfigPath(repoPath));
}

export function saveGlobalConfig(config: AgentConfig): string {
  ensureConfigDir();
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return GLOBAL_CONFIG_PATH;
}

export function saveRepoConfig(repoPath: string, config: AgentConfig): string {
  const filePath = repoConfigPath(repoPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return filePath;
}

export function mergeConfigs(
  base: AgentConfig,
  override: Partial<AgentConfig> | AgentConfig | null,
): AgentConfig {
  if (!override) return { ...base, models: { ...base.models } };
  return AgentConfigSchema.parse({
    version: 1,
    models: {
      ...base.models,
      ...(override.models ?? {}),
    },
    browserMcp: override.browserMcp ?? base.browserMcp,
  });
}
