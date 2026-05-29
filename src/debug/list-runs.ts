import chalk from "chalk";
import type { RunListRow } from "./run-store.js";

function formatTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function printRunTable(rows: RunListRow[]): void {
  if (rows.length === 0) {
    console.log(chalk.dim("No runs found."));
    return;
  }

  for (const r of rows) {
    const statusColor =
      r.runStatus === "interrupted"
        ? chalk.yellow
        : r.runStatus === "running"
          ? chalk.cyan
          : r.runStatus === "failed"
            ? chalk.red
            : chalk.green;

    console.log(
      `${chalk.bold(r.runId)}  ${statusColor(r.runStatus)}  ${chalk.dim(formatTs(r.updatedAt))}`,
    );
    console.log(
      chalk.dim(
        `  phase: ${r.currentPhase} → next: ${r.nextPhase}  cycles: ${r.cycles}`,
      ),
    );
    console.log(chalk.dim(`  repo: ${r.repoPath}`));
    console.log(chalk.dim(`  bug: ${truncate(r.bugDescription, 72)}`));
    if (r.sessionId) {
      console.log(chalk.dim(`  session: ${r.sessionId}`));
    }
    if (r.runStatus === "interrupted") {
      console.log(
        chalk.cyan(
          `  resume: debug resume ${JSON.stringify(r.repoPath)} --run ${r.runId}`,
        ),
      );
    }
    console.log();
  }
}
