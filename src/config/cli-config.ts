import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { runInteractivePicker } from "./picker.js";
import { printResolvedConfig } from "./show.js";
import { saveGlobalConfig, saveRepoConfig } from "./store.js";
import { AgentConfigSchema, type BrowserMcp } from "./types.js";

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("View or edit agent model and browser MCP preferences");

  config
    .command("show [repo]")
    .description("Show effective config (global + repo merge)")
    .action((repoArg: string | undefined) => {
      const repoPath = path.resolve(repoArg ?? ".");
      printResolvedConfig(repoPath);
    });

  config
    .command("init [repo]")
    .description("Interactive model picker; saves ~/.debug-agent/config.json")
    .option("--repo-override", "Also write .debug-agent/config.json in the repo")
    .action(async (repoArg: string | undefined, opts: { repoOverride?: boolean }) => {
      const repoPath = path.resolve(repoArg ?? ".");
      if (!process.stdin.isTTY) {
        console.error(chalk.red("init requires an interactive terminal (TTY)."));
        process.exit(1);
      }
      await runInteractivePicker({
        repoPath,
        saveGlobal: true,
      });
      if (opts.repoOverride) {
        const { resolveAgentConfig } = await import("./resolve.js");
        const resolved = resolveAgentConfig({ repoPath });
        const pathWritten = saveRepoConfig(repoPath, {
          version: 1,
          models: resolved.models,
          browserMcp: resolved.browserMcp,
        });
        console.log(chalk.green(`Repo override: ${pathWritten}`));
      }
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
      const repoPath = path.resolve(repoArg ?? ".");
      if (!opts.global && !opts.repo) {
        console.error(chalk.red("Pass --global and/or --repo to choose where to save."));
        process.exit(1);
      }

      if (opts.browserMcp) {
        const parsed = AgentConfigSchema.shape.browserMcp.safeParse(opts.browserMcp);
        if (!parsed.success) {
          console.error(chalk.red("--browser-mcp must be chrome-devtools or playwright"));
          process.exit(1);
        }
      }

      const { resolveAgentConfig } = await import("./resolve.js");
      const current = resolveAgentConfig({ repoPath });
      const merged = AgentConfigSchema.parse({
        version: 1,
        models: {
          planner: opts.planner ?? current.models.planner,
          fixer: opts.fixer ?? current.models.fixer,
          reviewer: opts.reviewer ?? current.models.reviewer,
        },
        browserMcp:
          (opts.browserMcp as BrowserMcp | undefined) ?? current.browserMcp,
      });

      if (opts.global) {
        console.log(chalk.green(`Updated ${saveGlobalConfig(merged)}`));
      }
      if (opts.repo) {
        console.log(chalk.green(`Updated ${saveRepoConfig(repoPath, merged)}`));
      }
      printResolvedConfig(repoPath);
    });

  config.action((repoArg: string | undefined) => {
    const repoPath = path.resolve(repoArg ?? ".");
    printResolvedConfig(repoPath);
  });
}
