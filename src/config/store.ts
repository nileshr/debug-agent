import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { AgentConfigSchema, type AgentConfig } from "./types.js";
import { CONFIG_DIR, GLOBAL_CONFIG_PATH, repoConfigPath } from "./paths.js";

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export interface ConfigFileIssue {
  filePath: string;
  message: string;
}

function formatZodError(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function readConfigFile(
  filePath: string,
): { config: AgentConfig | null; issue: ConfigFileIssue | null } {
  if (!fs.existsSync(filePath)) {
    return { config: null, issue: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const config = AgentConfigSchema.parse(raw);
    return { config, issue: null };
  } catch (err) {
    const message =
      err instanceof ZodError
        ? formatZodError(err)
        : err instanceof SyntaxError
          ? `Invalid JSON: ${err.message}`
          : (err as Error).message;
    return {
      config: null,
      issue: { filePath, message },
    };
  }
}

export function loadGlobalConfig(): AgentConfig | null {
  return readConfigFile(GLOBAL_CONFIG_PATH).config;
}

export function loadRepoConfig(repoPath: string): AgentConfig | null {
  return readConfigFile(repoConfigPath(repoPath)).config;
}

/** Load global config; returns parse issue instead of throwing. */
export function loadGlobalConfigWithIssue(): {
  config: AgentConfig | null;
  issue: ConfigFileIssue | null;
} {
  return readConfigFile(GLOBAL_CONFIG_PATH);
}

export function loadRepoConfigWithIssue(repoPath: string): {
  config: AgentConfig | null;
  issue: ConfigFileIssue | null;
} {
  return readConfigFile(repoConfigPath(repoPath));
}

export function saveGlobalConfig(config: AgentConfig): string {
  ensureConfigDir();
  const parsed = AgentConfigSchema.parse(config);
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return GLOBAL_CONFIG_PATH;
}

export function saveRepoConfig(repoPath: string, config: AgentConfig): string {
  const parsed = AgentConfigSchema.parse(config);
  const filePath = repoConfigPath(repoPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
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
