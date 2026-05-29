import chalk from "chalk";
import { needsInteractiveConfig } from "./resolve.js";
import { runInteractivePicker } from "./picker.js";
import { saveRepoConfig } from "./store.js";
import type { AgentConfig } from "./types.js";

export interface EnsureAgentConfigOptions {
  repoPath: string;
  /** Skip interactive picker even when no config exists */
  noPrompt?: boolean;
  /** After interactive pick, also write repo-level override */
  saveRepoOverride?: boolean;
}

/**
 * When no global or repo config exists, run interactive picker (TTY only).
 * Non-TTY environments use built-in defaults without writing files.
 */
export async function ensureAgentConfig(
  options: EnsureAgentConfigOptions,
): Promise<AgentConfig | null> {
  if (!needsInteractiveConfig(options.repoPath)) {
    return null;
  }
  if (options.noPrompt) {
    return null;
  }
  if (!process.stdin.isTTY) {
    console.log(
      chalk.dim(
        "No agent config found; using built-in defaults. Run `debug config init` to save preferences.\n",
      ),
    );
    return null;
  }

  const config = await runInteractivePicker({
    repoPath: options.repoPath,
    saveGlobal: true,
  });

  if (options.saveRepoOverride) {
    const path = saveRepoConfig(options.repoPath, config);
    console.log(chalk.green(`Saved repo override: ${path}`));
  }

  return config;
}
