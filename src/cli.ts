#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { DebugLoopController } from "./debug/controller.js";
import { runSetup, exitCodeForReport } from "./setup/run-setup.js";

const program = new Command();

program
  .name("debug")
  .description(
    "debug-agent: ACP debugger with emulated Cursor Debug Mode (hypothesize → instrument → reproduce → fix → verify → review)",
  );

program
  .command("setup")
  .description("Verify prerequisites and suggest fixes before running debug-agent")
  .option("--repo <path>", "Also check target repo .cursor/mcp.json")
  .option("--skip-acp-probe", "Skip live ACP authenticate/session probe (faster)")
  .option("--json", "Print machine-readable JSON")
  .action(async (opts) => {
    const report = await runSetup({
      repoPath: opts.repo ? path.resolve(opts.repo) : undefined,
      skipAcpProbe: opts.skipAcpProbe,
      json: opts.json,
    });
    process.exit(exitCodeForReport(report));
  });

program
  .command("run <repo>")
  .description("Run the emulated Debug Mode loop on a repository")
  .requiredOption("--bug <description>", "Bug description")
  .requiredOption("--url <url>", "App URL to reproduce in Chrome via chrome-devtools MCP")
  .option("--model <id>", "ACP model id", "composer-2.5[fast=true]")
  .option("--reviewer <name>", "Review subagent label", "code-review")
  .option("--max-cycles <n>", "Max verify/fix cycles", "5")
  .option("--no-report", "Skip HTML report generation")
  .option("--no-open", "Print file:// link only; do not open browser")
  .action(async (repoArg: string, opts) => {
    await runDebugAgent(repoArg, opts);
  });

// Default: `debug <repo> --bug ...` (same as `debug run <repo>`)
program
  .argument("[repo]", "Repository path (use `debug run <repo>` or `debug setup`)")
  .option("--bug <description>", "Bug description")
  .option("--url <url>", "App URL for chrome-devtools reproduction")
  .option("--model <id>", "ACP model id", "composer-2.5[fast=true]")
  .option("--reviewer <name>", "Review subagent label", "code-review")
  .option("--max-cycles <n>", "Max verify/fix cycles", "5")
  .option("--no-report", "Skip HTML report generation")
  .option("--no-open", "Print file:// link only; do not open browser")
  .action(async (repoArg: string | undefined, opts) => {
    if (!repoArg) {
      program.help();
      return;
    }
    if (!opts.bug || !opts.url) {
      console.error(
        chalk.red("Missing --bug and --url. Example:\n") +
          chalk.dim(
            '  debug ./my-app --bug "Save fails" --url "http://localhost:3000"\n',
          ),
      );
      process.exit(1);
    }
    await runDebugAgent(repoArg, opts);
  });

async function runDebugAgent(
  repoArg: string,
  opts: {
    bug: string;
    url: string;
    model?: string;
    reviewer?: string;
    maxCycles?: string;
    report?: boolean;
    noOpen?: boolean;
  },
): Promise<void> {
  const repoPath = path.resolve(repoArg);
  const maxCycles = parseInt(opts.maxCycles ?? "5", 10);
  if (Number.isNaN(maxCycles) || maxCycles < 1) {
    console.error(chalk.red("--max-cycles must be a positive integer"));
    process.exit(1);
  }

  const openReport = !opts.noOpen;

  console.log(chalk.bold("debug-agent (ACP + emulated Debug Mode)"));
  console.log(chalk.dim(`Repo: ${repoPath}`));
  console.log(chalk.dim(`URL:  ${opts.url}`));
  console.log(
    chalk.dim(`Tip: run \`debug setup --repo ${repoPath}\` to verify prerequisites.\n`),
  );

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
      onPhase: () => {},
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
}

program.parse();
