#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { DebugLoopController } from "./debug/controller.js";

const program = new Command();

program
  .name("bugfix")
  .description(
    "ACP bug-fix agent with emulated Cursor Debug Mode (hypothesize → instrument → reproduce → fix → verify → review)",
  )
  .argument("<repo>", "Path to the repository under debug")
  .requiredOption("--bug <description>", "Bug description")
  .requiredOption("--url <url>", "App URL to reproduce in Chrome via chrome-devtools MCP")
  .option("--model <id>", "ACP model id", "composer-2.5[fast=true]")
  .option("--reviewer <name>", "Review subagent label", "code-review")
  .option("--max-cycles <n>", "Max verify/fix cycles", "5")
  .option("--no-report", "Skip HTML report generation")
  .option("--no-open", "Print file:// link only; do not open browser")
  .action(async (repoArg: string, opts) => {
    const repoPath = path.resolve(repoArg);
    const maxCycles = parseInt(opts.maxCycles, 10);
    if (Number.isNaN(maxCycles) || maxCycles < 1) {
      console.error(chalk.red("--max-cycles must be a positive integer"));
      process.exit(1);
    }

    const openReport = !opts.noOpen;

    console.log(chalk.bold("Debug Agent (ACP + emulated Debug Mode)"));
    console.log(chalk.dim(`Repo: ${repoPath}`));
    console.log(chalk.dim(`URL:  ${opts.url}`));
    console.log(chalk.dim(`Note: native Debug Mode is not exposed in ACP; loop is emulated.\n`));

    try {
      const controller = new DebugLoopController({
        repoPath,
        url: opts.url,
        bugDescription: opts.bug,
        model: opts.model,
        reviewer: opts.reviewer,
        maxCycles,
        writeReport: opts.report !== false,
        openReport,
        onPhase: () => {
          // phases logged by ora in controller
        },
      });

      const result = await controller.run();

      console.log(chalk.green(`\nRun ${result.ledger.runId} finished: ${result.ledger.status}`));
      if (result.reportPath) {
        console.log(chalk.cyan(`Report: ${result.reportPath}`));
      }
      process.exit(result.ledger.status === "fixed" ? 0 : 2);
    } catch (err) {
      console.error(chalk.red("Fatal:"), (err as Error).message);
      if ((err as Error).stack) {
        console.error(chalk.dim((err as Error).stack));
      }
      process.exit(1);
    }
  });

program.parse();
