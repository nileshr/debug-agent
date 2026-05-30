import chalk from "chalk";

export interface UserFacingError {
  title: string;
  detail: string;
  hints?: string[];
  cause?: string;
}

export function formatUserError(err: UserFacingError): string {
  const lines = [
    chalk.red.bold(err.title),
    "",
    err.detail,
  ];
  if (err.cause) {
    lines.push("", chalk.dim(`Cause: ${err.cause}`));
  }
  if (err.hints?.length) {
    lines.push("", chalk.yellow("What to try:"));
    for (const h of err.hints) {
      lines.push(chalk.yellow(`  • ${h}`));
    }
  }
  return lines.join("\n");
}

export function errorFromUnknown(err: unknown, title = "Something went wrong"): UserFacingError {
  if (err instanceof Error) {
    return {
      title,
      detail: err.message,
      cause: err.name !== "Error" ? err.name : undefined,
    };
  }
  return { title, detail: String(err) };
}

export function printUserError(err: UserFacingError, logPath?: string): void {
  console.error(formatUserError(err));
  if (logPath) {
    console.error(
      chalk.dim(`\nFull log: ${logPath}\nShare this file when reporting issues.`),
    );
  }
}

export function exitWithError(err: UserFacingError, logPath?: string): never {
  printUserError(err, logPath);
  process.exit(1);
}
