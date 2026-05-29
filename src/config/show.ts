import chalk from "chalk";
import { GLOBAL_CONFIG_PATH, repoConfigPath } from "./paths.js";
import { resolveAgentConfig } from "./resolve.js";
import type { ResolvedAgentConfig } from "./types.js";

export function formatResolvedConfig(
  config: ResolvedAgentConfig,
  repoPath: string,
): string {
  const lines = [
    chalk.bold("Agent config"),
    chalk.dim(`Global: ${GLOBAL_CONFIG_PATH}`),
    chalk.dim(`Repo:   ${repoConfigPath(repoPath)} (optional override)`),
    "",
    `  Planner:  ${config.models.planner}  ${chalk.dim(`[${config.sources.planner}]`)}`,
    `  Fixer:    ${config.models.fixer}  ${chalk.dim(`[${config.sources.fixer}]`)}`,
    `  Reviewer: ${config.models.reviewer}  ${chalk.dim(`[${config.sources.reviewer}]`)}`,
    `  Browser:  ${config.browserMcp}  ${chalk.dim(`[${config.sources.browserMcp}]`)}`,
  ];
  return lines.join("\n");
}

export function printResolvedConfig(repoPath: string): ResolvedAgentConfig {
  const config = resolveAgentConfig({ repoPath });
  console.log(formatResolvedConfig(config, repoPath));
  return config;
}
