import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import type { Hypothesis, RunLedger } from "./types.js";

function hypothesesBlock(hypotheses: Hypothesis[]): string {
  if (hypotheses.length === 0) return "(none parsed — check agent output)";
  return hypotheses
    .map(
      (h) =>
        `  ${h.id} [${h.status}] rank=${h.rank}: ${h.statement}` +
        (h.file ? ` @ ${h.file}${h.line != null ? `:${h.line}` : ""}` : ""),
    )
    .join("\n");
}

/**
 * Pause after hypothesize so the user can review the plan before instrumenting.
 * Returns true to continue, false to abort the run.
 */
export async function confirmPlanAfterHypothesis(ledger: RunLedger): Promise<boolean> {
  console.log(chalk.bold("\n── Hypotheses / plan ──"));
  console.log(hypothesesBlock(ledger.hypotheses));
  if (ledger.todos.length > 0 && ledger.hypotheses.length === 0) {
    console.log(chalk.dim("\nAgent todos:"));
    for (const t of ledger.todos) {
      console.log(chalk.dim(`  ${t.id}: ${t.content}`));
    }
  }
  console.log("");

  if (!process.stdin.isTTY) {
    console.log(
      chalk.yellow(
        "Non-interactive terminal: skipping plan confirmation (omit --confirm-plan to silence this note).",
      ),
    );
    return true;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      chalk.cyan("Continue to instrument & fix? [Y/n]: "),
    );
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "n" || trimmed === "no") {
      console.log(chalk.dim("Stopped after plan. Resume with `debug resume` when ready."));
      return false;
    }
    return true;
  } finally {
    rl.close();
  }
}
