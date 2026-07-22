import chalk from "chalk";
import type { Phase } from "../debug/types.js";
import { DEFAULT_AGENT_CONFIG } from "./defaults.js";
import { hasAnyAgentConfig } from "./paths.js";
import {
  loadGlobalConfigWithIssue,
  loadRepoConfigWithIssue,
  mergeConfigs,
} from "./store.js";
import type {
  AgentConfig,
  AgentConfigOverrides,
  ConfigSource,
  ResolvedAgentConfig,
} from "./types.js";

export interface ResolveAgentConfigOptions {
  repoPath: string;
  overrides?: AgentConfigOverrides;
  /** When false, skip printing warnings for invalid config files (caller handles). */
  warnOnIssues?: boolean;
}

function sourceForField(
  field: keyof AgentConfig["models"] | "browserMcp",
  layers: {
    global: AgentConfig | null;
    repo: AgentConfig | null;
    cli: AgentConfigOverrides | undefined;
  },
): ConfigSource {
  const cliVal =
    field === "browserMcp"
      ? layers.cli?.browserMcp
      : layers.cli?.[field as keyof AgentConfig["models"]];
  if (cliVal !== undefined) {
    return "cli";
  }
  if (field === "browserMcp") {
    if (layers.repo?.browserMcp) return "repo";
    if (layers.global?.browserMcp) return "global";
    return "default";
  }
  const modelField = field as keyof AgentConfig["models"];
  if (layers.repo?.models[modelField]) return "repo";
  if (layers.global?.models[modelField]) return "global";
  return "default";
}

export function resolveAgentConfig(
  options: ResolveAgentConfigOptions,
): ResolvedAgentConfig {
  const warn = options.warnOnIssues !== false;
  const globalLoad = loadGlobalConfigWithIssue();
  const repoLoad = loadRepoConfigWithIssue(options.repoPath);

  if (warn) {
    if (globalLoad.issue) {
      console.error(
        chalk.yellow(
          `Ignoring invalid global config (${globalLoad.issue.filePath}): ${globalLoad.issue.message}`,
        ),
      );
      console.error(chalk.dim("Using defaults for missing fields. Fix with `debug config init -y` or edit the file.\n"));
    }
    if (repoLoad.issue) {
      console.error(
        chalk.yellow(
          `Ignoring invalid repo config (${repoLoad.issue.filePath}): ${repoLoad.issue.message}`,
        ),
      );
      console.error(chalk.dim("Using global/defaults for missing fields.\n"));
    }
  }

  const global = globalLoad.config;
  const repo = repoLoad.config;
  const cli = options.overrides;

  let merged = { ...DEFAULT_AGENT_CONFIG, models: { ...DEFAULT_AGENT_CONFIG.models } };
  if (global) merged = mergeConfigs(merged, global);
  if (repo) merged = mergeConfigs(merged, repo);

  if (
    cli?.planner ||
    cli?.fixer ||
    cli?.reviewer ||
    cli?.orchestrator ||
    cli?.browserMcp ||
    cli?.runtime ||
    cli?.autonomy ||
    cli?.agentPreset
  ) {
    merged = mergeConfigs(merged, {
      version: 2,
      models: {
        planner: cli.planner ?? merged.models.planner,
        fixer: cli.fixer ?? merged.models.fixer,
        reviewer: cli.reviewer ?? merged.models.reviewer,
        orchestrator: cli.orchestrator ?? merged.models.orchestrator,
      },
      browserMcp: cli.browserMcp ?? merged.browserMcp,
      runtime: cli.runtime ?? merged.runtime,
      autonomy: cli.autonomy ?? merged.autonomy,
      acp: cli.agentPreset
        ? { ...(merged.acp ?? { preset: "cursor" }), preset: cli.agentPreset }
        : merged.acp,
    });
  }

  return {
    ...merged,
    sources: {
      planner: sourceForField("planner", { global, repo, cli }),
      fixer: sourceForField("fixer", { global, repo, cli }),
      reviewer: sourceForField("reviewer", { global, repo, cli }),
      browserMcp: sourceForField("browserMcp", { global, repo, cli }),
    },
  };
}

/** ACP model id for a debug-loop phase. */
export function modelForPhase(
  phase: Phase,
  models: AgentConfig["models"],
): string {
  if (phase === "hypothesize") return models.planner;
  if (phase === "review") return models.reviewer;
  return models.fixer;
}

export function needsInteractiveConfig(repoPath: string): boolean {
  return !hasAnyAgentConfig(repoPath);
}
