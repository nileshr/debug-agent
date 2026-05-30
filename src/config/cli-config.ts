import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { DEFAULT_AGENT_CONFIG } from "./defaults.js";
import { runInteractivePicker } from "./picker.js";
import { printResolvedConfig } from "./show.js";
import { saveGlobalConfig, saveRepoConfig } from "./store.js";
import { AgentConfigSchema, type BrowserMcp } from "./types.js";
import { errorFromUnknown, exitWithError, formatUserError } from "../util/errors.js";

function handleConfigAction(fn: () => void | Promise<void>): void {
  Promise.resolve()
    .then(fn)
    .catch((err: unknown) => {
      const facing = errorFromUnknown(err, "Config command failed");
      facing.hints = [
        "Run `debug config init -y` to reset global defaults.",
        "Validate JSON in ~/.debug-agent/config.json and repo .debug-agent/config.json.",
      ];
      exitWithError(facing);
    });
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("View or edit agent model and browser MCP preferences");

  config
    .command("show [repo]")
    .description("Show effective config (global + repo merge)")
    .action((repoArg: string | undefined) => {
      handleConfigAction(() => {
        const repoPath = path.resolve(repoArg ?? ".");
        printResolvedConfig(repoPath);
      });
    });

  config
    .command("init [repo]")
    .description("Configure models and browser MCP; saves ~/.debug-agent/config.json")
    .option("-y, --yes", "Write built-in defaults without prompts (non-interactive)")
    .option("--repo-override", "Also write .debug-agent/config.json in the repo")
    .action(async (repoArg: string | undefined, opts: { yes?: boolean; repoOverride?: boolean }) => {
      handleConfigAction(async () => {
        const repoPath = path.resolve(repoArg ?? ".");

        if (opts.yes) {
          const saved = saveGlobalConfig(DEFAULT_AGENT_CONFIG);
          console.log(chalk.green(`Saved global defaults: ${saved}`));
          if (opts.repoOverride) {
            const pathWritten = saveRepoConfig(repoPath, DEFAULT_AGENT_CONFIG);
            console.log(chalk.green(`Repo override: ${pathWritten}`));
          }
          printResolvedConfig(repoPath);
          return;
        }

        if (!process.stdin.isTTY) {
          exitWithError({
            title: "Interactive init needs a terminal",
            detail: "stdin is not a TTY.",
            hints: [
              "Run `debug config init -y` to save defaults without prompts.",
              "Or run from an interactive shell.",
            ],
          });
        }

        await runInteractivePicker({
          repoPath,
          saveGlobal: true,
        });
        if (opts.repoOverride) {
          const { resolveAgentConfig } = await import("./resolve.js");
          const resolved = resolveAgentConfig({ repoPath, warnOnIssues: false });
          const pathWritten = saveRepoConfig(repoPath, {
            version: 1,
            models: resolved.models,
            browserMcp: resolved.browserMcp,
          });
          console.log(chalk.green(`Repo override: ${pathWritten}`));
        }
        printResolvedConfig(repoPath);
      });
    });

  config
    .command("set [repo]")
    .description("Set config fields (global and/or repo)")
    .option("--global", "Write ~/.debug-agent/config.json")
    .option("--repo", "Write .debug-agent/config.json in the target repo")
    .option("--planner <id>", "Planner model id")
    .option("--fixer <id>", "Fixer model id")
    .option("--reviewer <id>", "Reviewer model id")
    .option(
      "--browser-mcp <kind>",
      "chrome-devtools | playwright",
    )
    .action(async (repoArg: string | undefined, opts) => {
      handleConfigAction(async () => {
        const repoPath = path.resolve(repoArg ?? ".");
        if (!opts.global && !opts.repo) {
          exitWithError({
            title: "Missing --global or --repo",
            detail: "Choose where to save the updated config.",
            hints: [
              "Example: debug config set --global --browser-mcp playwright",
              "Example: debug config set --repo . --fixer composer-2.5[fast=true]",
            ],
          });
        }

        if (opts.browserMcp) {
          const parsed = AgentConfigSchema.shape.browserMcp.safeParse(opts.browserMcp);
          if (!parsed.success) {
            exitWithError({
              title: "Invalid --browser-mcp",
              detail: `"${opts.browserMcp}" is not supported.`,
              hints: ["Use chrome-devtools or playwright."],
            });
          }
        }

        const { resolveAgentConfig } = await import("./resolve.js");
        const current = resolveAgentConfig({ repoPath, warnOnIssues: false });
        const mergedResult = AgentConfigSchema.safeParse({
          version: 1,
          models: {
            planner: opts.planner ?? current.models.planner,
            fixer: opts.fixer ?? current.models.fixer,
            reviewer: opts.reviewer ?? current.models.reviewer,
          },
          browserMcp:
            (opts.browserMcp as BrowserMcp | undefined) ?? current.browserMcp,
        });

        if (!mergedResult.success) {
          console.error(formatUserError({
            title: "Config validation failed",
            detail: mergedResult.error.issues.map((i) => i.message).join("; "),
          }));
          process.exit(1);
        }

        const merged = mergedResult.data;

        if (opts.global) {
          console.log(chalk.green(`Updated ${saveGlobalConfig(merged)}`));
        }
        if (opts.repo) {
          console.log(chalk.green(`Updated ${saveRepoConfig(repoPath, merged)}`));
        }
        printResolvedConfig(repoPath);
      });
    });

  config.action((repoArg: string | undefined) => {
    handleConfigAction(() => {
      const repoPath = path.resolve(repoArg ?? ".");
      printResolvedConfig(repoPath);
    });
  });
}
