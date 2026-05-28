import chalk from "chalk";
import type { CheckResult, SetupReport } from "./types.js";
import { runAllChecks, type RunChecksOptions } from "./checks.js";

function summarize(checks: CheckResult[]): SetupReport {
  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  return {
    checks,
    passed,
    warned,
    failed,
    ready: failed === 0,
  };
}

function icon(status: CheckResult["status"]): string {
  switch (status) {
    case "pass":
      return chalk.green("✓");
    case "warn":
      return chalk.yellow("!");
    case "fail":
      return chalk.red("✗");
  }
}

export async function runSetup(options: RunChecksOptions & { json?: boolean }): Promise<SetupReport> {
  const checks = await runAllChecks(options);
  const report = summarize(checks);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(chalk.bold("\nbugfix setup — environment check\n"));

  for (const c of checks) {
    console.log(`${icon(c.status)} ${chalk.bold(c.name)}`);
    console.log(`  ${c.message}`);
    if (c.suggestion && c.status !== "pass") {
      console.log(chalk.dim(`  → ${c.suggestion.replace(/\n/g, "\n    ")}`));
    }
    console.log();
  }

  console.log(
    chalk.dim(
      `${report.passed} passed, ${report.warned} warning(s), ${report.failed} failed`,
    ),
  );

  if (report.ready) {
    console.log(
      chalk.green(
        "\nReady to run:\n  bugfix /path/to/repo --bug \"...\" --url \"http://localhost:3000\"\n",
      ),
    );
  } else {
    console.log(
      chalk.red(
        "\nFix the failed checks above before running bugfix.\n",
      ),
    );
  }

  return report;
}

export function exitCodeForReport(report: SetupReport): number {
  return report.failed > 0 ? 1 : 0;
}
