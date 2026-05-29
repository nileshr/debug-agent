#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { DebugLoopController } from "./debug/controller.js";
import { resolveVerifyTarget } from "./debug/verify-target.js";
import { runSetup, exitCodeForReport } from "./setup/run-setup.js";
import { runUpgrade, exitCodeForUpgrade } from "./setup/upgrade.js";
import { getVersion } from "./version.js";

const program = new Command();

/** Subcommands and global flags — everything else is `debug <repo> …` shorthand for `debug run`. */
const TOP_LEVEL_COMMANDS = new Set([
  "setup",
  "upgrade",
  "run",
  "-h",
  "--help",
  "-v",
  "-V",
  "--version",
]);

function argvWithRunShorthand(argv: string[]): string[] {
  const args = argv.slice(2);
  if (
    args.length > 0 &&
    !TOP_LEVEL_COMMANDS.has(args[0]) &&
    !args[0].startsWith("-")
  ) {
    return [argv[0], argv[1], "run", ...args];
  }
  return argv;
}

const pkgVersion = getVersion();

function printVersionAndExit(): void {
  process.stdout.write(`${pkgVersion}\n`);
  process.exit(0);
}

program
  .name("debug")
  .description(
    "debug-agent: ACP debugger with emulated Cursor Debug Mode (hypothesize → instrument → reproduce → fix → verify → review)",
  )
  .version(pkgVersion, "-v, --version", "Show version");

// Commander allows one short flag per option; register -V as alias
const versionAliasV = program.createOption("-V", "Show version");
program.addOption(versionAliasV);
program.on("option:V", printVersionAndExit);

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
  .command("upgrade")
  .description("Upgrade debug-agent (GitHub release, git clone, or local dev checkout)")
  .option("--check", "Only check for a newer version on GitHub")
  .option("--force", "Reinstall even if version matches")
  .action(async (opts) => {
    const result = await runUpgrade({
      check: opts.check,
      force: opts.force,
    });
    process.exit(exitCodeForUpgrade(result, { check: opts.check }));
  });

program
  .command("run [repo]")
  .description("Run the emulated Debug Mode loop on a repository")
  .argument(
    "[description...]",
    "Bug description when --bug is omitted (e.g. debug run \"save fails\")",
  )
  .option("--bug <description>", "Bug description")
  .option("--url <url>", "App URL for browser verification (omit for CLI/shell verification)")
  .option("--model <id>", "ACP model id", "composer-2.5[fast=true]")
  .option("--reviewer <name>", "Review subagent label", "code-review")
  .option("--max-cycles <n>", "Max verify/fix cycles", "5")
  .option("--no-report", "Skip HTML report generation")
  .option("--no-open", "Print file:// link only; do not open browser")
  .option(
    "--session <id>",
    "Resume an existing ACP agent session (session/load) instead of creating a new one",
  )
  .action(async (repoArg: string | undefined, descriptionParts: string[], opts) => {
    let repo = ".";
    let bug = opts.bug?.trim() ?? "";

    if (descriptionParts.length > 0) {
      bug = bug || descriptionParts.join(" ").trim();
      if (repoArg && looksLikeRepoPath(repoArg)) {
        repo = repoArg;
      }
    } else if (repoArg) {
      if (looksLikeRepoPath(repoArg)) {
        repo = repoArg;
      } else if (!bug) {
        bug = repoArg.trim();
      }
    }

    if (!bug) {
      console.error(
        chalk.red("Missing bug description. Use --bug or a positional prompt. Example:\n") +
          chalk.dim(
            '  debug run --bug "Save fails"\n' +
              '  debug run "Save fails"\n' +
              '  debug ./my-app --bug "Save fails" --url "http://localhost:3000"\n',
          ),
      );
      process.exit(1);
    }

    const repoPath = path.resolve(repo);
    const verifyTarget = resolveVerifyTarget(repoPath, opts.url);
    await runDebugAgent(repoPath, { ...opts, bug, verifyTarget });
  });

function looksLikeRepoPath(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

async function runDebugAgent(
  repoPath: string,
  opts: {
    bug: string;
    verifyTarget: ReturnType<typeof resolveVerifyTarget>;
    model?: string;
    reviewer?: string;
    maxCycles?: string;
    report?: boolean;
    noOpen?: boolean;
    session?: string;
  },
): Promise<void> {
  const maxCycles = parseInt(opts.maxCycles ?? "5", 10);
  if (Number.isNaN(maxCycles) || maxCycles < 1) {
    console.error(chalk.red("--max-cycles must be a positive integer"));
    process.exit(1);
  }

  const openReport = !opts.noOpen;

  console.log(chalk.bold("debug-agent (ACP + emulated Debug Mode)"));
  console.log(chalk.dim(`Repo: ${repoPath}`));
  if (opts.verifyTarget.mode === "browser") {
    console.log(chalk.dim(`Verify: browser · ${opts.verifyTarget.url}`));
  } else {
    console.log(chalk.dim("Verify: CLI (shell commands, no browser)"));
  }
  console.log(
    chalk.dim(`Tip: run \`debug setup --repo ${repoPath}\` to verify prerequisites.\n`),
  );

  try {
    const controller = new DebugLoopController({
      repoPath,
      verifyMode: opts.verifyTarget.mode,
      url: opts.verifyTarget.url,
      bugDescription: opts.bug,
      model: opts.model,
      reviewer: opts.reviewer,
      maxCycles,
      writeReport: opts.report !== false,
      openReport,
      resumeSessionId: opts.session?.trim() || undefined,
      onPhase: () => {},
    });

    const result = await controller.run();

    console.log(chalk.green(`\nRun ${result.ledger.runId} finished: ${result.ledger.status}`));
    console.log(
      chalk.dim(
        `Session: ${result.ledger.sessionId}${result.ledger.sessionResumed ? " (resumed)" : ""}`,
      ),
    );
    const { formatAgentResumeCommand, formatDebugResumeCommand } = await import(
      "./debug/session-info.js"
    );
    console.log(
      chalk.dim(
        `Resume: ${formatDebugResumeCommand({
          sessionId: result.ledger.sessionId,
          repoPath,
          bugDescription: opts.bug,
          url: opts.verifyTarget.url,
        })}`,
      ),
    );
    console.log(
      chalk.dim(`Agent:  ${formatAgentResumeCommand(result.ledger.sessionId)}`),
    );
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

program.parse(argvWithRunShorthand(process.argv));
