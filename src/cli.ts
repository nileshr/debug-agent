#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { resolveVerifyTarget } from "./debug/verify-target.js";
import { runSetup, exitCodeForReport } from "./setup/run-setup.js";
import { runUpgrade, exitCodeForUpgrade } from "./setup/upgrade.js";
import { getVersion } from "./version.js";
import { registerConfigCommand } from "./config/cli-config.js";
import { ensureAgentConfig } from "./config/ensure.js";
import { resolveAgentConfig } from "./config/resolve.js";
import { formatResolvedConfig } from "./config/show.js";
import type { AgentConfigOverrides } from "./config/types.js";
import { CHROME_DEVTOOLS_ALLOW_PROMPT_MESSAGE } from "./mcp/browser.js";
import { RunLogWriter, LOGS_DIR } from "./logging/run-log.js";
import { errorFromUnknown, printUserError } from "./util/errors.js";

const program = new Command();

/** Subcommands and global flags — everything else is `debug <repo> …` shorthand for `debug run`. */
const TOP_LEVEL_COMMANDS = new Set([
  "setup",
  "upgrade",
  "config",
  "run",
  "resume",
  "runs",
  "report",
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

/** Avoid loading sqlite-backed modules for bare version flags. */
function isVersionOnlyInvocation(argv: string[]): boolean {
  const args = argv.slice(2);
  return args.length === 1 && (args[0] === "-v" || args[0] === "-V" || args[0] === "--version");
}

if (isVersionOnlyInvocation(process.argv)) {
  printVersionAndExit();
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

registerConfigCommand(program);

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
  .command("runs")
  .description("List debug runs tracked in ~/.debug-agent/state.db")
  .option("--repo <path>", "Filter by repository path")
  .option(
    "--status <status>",
    "Filter: running | interrupted | completed | failed | all",
    "all",
  )
  .option("--limit <n>", "Max rows", "20")
  .action(async (opts) => {
    const { getRunStore } = await import("./debug/run-store.js");
    const { printRunTable } = await import("./debug/list-runs.js");
    const limit = parseInt(opts.limit ?? "20", 10);
    const status = opts.status as
      | "running"
      | "interrupted"
      | "completed"
      | "failed"
      | "all";
    const rows = getRunStore().listRuns({
      repoPath: opts.repo ? path.resolve(opts.repo) : undefined,
      runStatus: status,
      limit: Number.isNaN(limit) ? 20 : limit,
    });
    printRunTable(rows);
  });

program
  .command("report [repo]")
  .description(
    "Generate HTML report for a debug run (works mid-run from state DB + ledger file)",
  )
  .option("--run <id>", "Run id (default: latest running/interrupted, else latest for repo)")
  .option("--no-open", "Print file:// link only; do not open browser")
  .action(async (repoArg: string | undefined, opts) => {
    const repoPath = path.resolve(repoArg ?? ".");
    const { STATE_DB_PATH } = await import("./debug/run-store.js");
    const { resolveReportRunId, loadRunForReport } = await import(
      "./debug/load-run-ledger.js"
    );
    const { buildFinalReportFromLedger } = await import("./report/build-report.js");
    const { emitHtmlReport } = await import("./report/emit.js");

    let runId: string;
    try {
      runId = resolveReportRunId(repoPath, opts.run?.trim());
    } catch (err) {
      console.error(
        chalk.red((err as Error).message) +
          chalk.dim(`\nState DB: ${STATE_DB_PATH}\n`) +
          chalk.dim("List runs: debug runs --repo .\n"),
      );
      process.exit(1);
    }

    if (!opts.run?.trim()) {
      console.log(chalk.dim(`Using run: ${runId}`));
    }

    let resolved;
    try {
      resolved = loadRunForReport(repoPath, runId);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }

    const report = buildFinalReportFromLedger(resolved.ledger, {
      endedAt: resolved.endedAt,
      runLifecycleStatus: resolved.runLifecycleStatus,
      currentPhase: resolved.currentPhase,
      phaseTimeline: resolved.phaseTimeline,
    });

    const outPath = await emitHtmlReport(report, { open: !opts.noOpen });
    console.log(
      chalk.dim(
        `Run status: ${resolved.runLifecycleStatus} · phase: ${resolved.currentPhase}`,
      ),
    );
    console.log(chalk.cyan(`Report: ${outPath}`));
  });

program
  .command("resume [repo]")
  .description(
    "Resume an interrupted debug run (phase + ledger from state DB, ACP session/load)",
  )
  .option("--run <id>", "Run id (default: latest interrupted run for repo)")
  .option("--no-report", "Skip HTML report generation")
  .option("--no-open", "Print file:// link only; do not open browser")
  .action(async (repoArg: string | undefined, opts) => {
    const repoPath = path.resolve(repoArg ?? ".");
    const { getRunStore, STATE_DB_PATH } = await import("./debug/run-store.js");
    const store = getRunStore();
    let runId = opts.run?.trim();
    if (!runId) {
      runId = store.findLatestInterrupted(repoPath) ?? undefined;
      if (!runId) {
        console.error(
          chalk.red(`No interrupted run for ${repoPath}.`) +
            chalk.dim(`\nState DB: ${STATE_DB_PATH}\n`) +
            chalk.dim("List runs: debug runs --repo . --status interrupted\n"),
        );
        process.exit(1);
      }
      console.log(chalk.dim(`Using latest interrupted run: ${runId}`));
    }

    const loaded = store.loadRun(runId);
    if (!loaded) {
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    }
    if (path.resolve(loaded.repoPath) !== repoPath) {
      console.error(
        chalk.red(
          `Run ${runId} belongs to ${loaded.repoPath}, not ${repoPath}. Pass that repo path.`,
        ),
      );
      process.exit(1);
    }
    if (loaded.runStatus === "completed") {
      console.error(chalk.red(`Run ${runId} already completed.`));
      process.exit(1);
    }
    if (loaded.runStatus === "running") {
      console.error(
        chalk.red(
          `Run ${runId} is still marked running. Stop the other process or pick a different --run.`,
        ),
      );
      process.exit(1);
    }

    const verifyTarget = resolveVerifyTarget(repoPath, loaded.url);
    await runDebugAgent(repoPath, {
      bug: loaded.bugDescription,
      verifyTarget,
      configOverrides: {
        fixer: loaded.model,
        planner: loaded.ledger.plannerModel ?? loaded.model,
        reviewer: loaded.reviewer,
        browserMcp: loaded.ledger.browserMcp,
      },
      maxCycles: String(loaded.maxCycles),
      report: opts.report !== false,
      noOpen: opts.noOpen,
      session: loaded.sessionId,
      resumeRunId: runId,
      noConfigPrompt: true,
    });
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
  .option("--model <id>", "Fixer ACP model (overrides config)")
  .option("--planner-model <id>", "Planner model for hypothesize phase")
  .option("--reviewer-model <id>", "Reviewer model for review phase")
  .option("--browser-mcp <kind>", "chrome-devtools | playwright (browser verify)")
  .option("--runtime <kind>", "Agent runtime: acp | flue")
  .option(
    "--agent <preset>",
    "ACP agent preset: cursor | claude | codex | gemini | custom",
  )
  .option("--no-config-prompt", "Skip first-run interactive config picker")
  .option(
    "--confirm-plan",
    "After hypothesize, show the plan and wait for confirmation before fixing",
  )
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
    plannerModel?: string;
    reviewerModel?: string;
    browserMcp?: string;
    runtime?: string;
    agent?: string;
    configOverrides?: AgentConfigOverrides;
    maxCycles?: string;
    report?: boolean;
    noOpen?: boolean;
    noConfigPrompt?: boolean;
    confirmPlan?: boolean;
    session?: string;
    resumeRunId?: string;
  },
): Promise<void> {
  const maxCycles = parseInt(opts.maxCycles ?? "5", 10);
  if (Number.isNaN(maxCycles) || maxCycles < 1) {
    console.error(chalk.red("--max-cycles must be a positive integer"));
    process.exit(1);
  }

  if (opts.runtime && !["acp", "flue"].includes(opts.runtime)) {
    console.error(chalk.red(`Unknown --runtime "${opts.runtime}". Use: acp | flue`));
    process.exit(1);
  }
  if (
    opts.agent &&
    !["cursor", "claude", "codex", "gemini", "custom"].includes(opts.agent)
  ) {
    console.error(
      chalk.red(
        `Unknown --agent "${opts.agent}". Use: cursor | claude | codex | gemini | custom`,
      ),
    );
    process.exit(1);
  }

  const openReport = !opts.noOpen;

  await ensureAgentConfig({
    repoPath,
    noPrompt: opts.noConfigPrompt,
  });

  const overrides: AgentConfigOverrides = {
    ...opts.configOverrides,
    fixer: opts.model ?? opts.configOverrides?.fixer,
    planner: opts.plannerModel ?? opts.configOverrides?.planner,
    reviewer: opts.reviewerModel ?? opts.configOverrides?.reviewer,
    browserMcp:
      (opts.browserMcp as AgentConfigOverrides["browserMcp"] | undefined) ??
      opts.configOverrides?.browserMcp,
    runtime:
      (opts.runtime as AgentConfigOverrides["runtime"] | undefined) ??
      opts.configOverrides?.runtime,
    agentPreset:
      (opts.agent as AgentConfigOverrides["agentPreset"] | undefined) ??
      opts.configOverrides?.agentPreset,
  };
  const agentConfig = resolveAgentConfig({ repoPath, overrides });

  if (agentConfig.runtime === "flue") {
    console.error(
      chalk.red(
        "The flue runtime is not available yet in this build. Use --runtime acp.",
      ),
    );
    process.exit(1);
  }

  console.log(chalk.bold("debug-agent (ACP + emulated Debug Mode)"));
  console.log(chalk.dim(`Repo: ${repoPath}`));
  if (opts.verifyTarget.mode === "browser") {
    console.log(chalk.dim(`Verify: browser · ${opts.verifyTarget.url}`));
  } else {
    console.log(chalk.dim("Verify: CLI (shell commands, no browser)"));
  }
  console.log(formatResolvedConfig(agentConfig, repoPath));
  if (
    opts.verifyTarget.mode === "browser" &&
    agentConfig.browserMcp === "chrome-devtools"
  ) {
    console.log(chalk.yellow(`\n⚠ ${CHROME_DEVTOOLS_ALLOW_PROMPT_MESSAGE}\n`));
  }
  console.log(
    chalk.dim(`Tip: run \`debug setup --repo ${repoPath}\` to verify prerequisites.\n`),
  );

  const runLog = new RunLogWriter();
  runLog.line(`repo=${repoPath}`);
  runLog.line(`bug=${opts.bug}`);
  runLog.line(`verify=${opts.verifyTarget.mode}`);

  try {
    const { DebugLoopController } = await import("./debug/controller.js");
    const controller = new DebugLoopController({
      repoPath,
      verifyMode: opts.verifyTarget.mode,
      url: opts.verifyTarget.url,
      bugDescription: opts.bug,
      agentConfig,
      maxCycles,
      writeReport: opts.report !== false,
      openReport,
      confirmPlan: opts.confirmPlan,
      resumeSessionId: opts.session?.trim() || undefined,
      resumeRunId: opts.resumeRunId,
      runLog,
      onPhase: () => {},
    });

    const result = await controller.run();
    runLog.section("completed");
    runLog.line(`status=${result.ledger.status} runId=${result.ledger.runId}`);
    runLog.line(`sessionId=${result.ledger.sessionId}`);
    runLog.close();

    console.log(chalk.green(`\nRun ${result.ledger.runId} finished: ${result.ledger.status}`));
    console.log(chalk.dim(`Log: ${runLog.filePath}`));
    console.log(chalk.dim(`Logs dir: ${LOGS_DIR}`));
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
          runId: result.ledger.runId,
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
    runLog.section("fatal");
    runLog.line((err as Error).message);
    if ((err as Error).stack) runLog.line((err as Error).stack!);
    runLog.close();

    const facing = errorFromUnknown(err, "Debug run failed");
    facing.hints = [
      "Run `debug setup` to verify agent login and prerequisites.",
      "Run `debug config init -y` if config files are corrupt.",
      `Share the log file when reporting issues.`,
    ];
    printUserError(facing, runLog.filePath);
    process.exit(1);
  }
}

program.parse(argvWithRunShorthand(process.argv));
