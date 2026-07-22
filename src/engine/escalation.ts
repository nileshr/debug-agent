import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import type { UserAnswer, UserQuestion } from "../debug/types.js";

export function canAskInteractively(): boolean {
  return Boolean(process.stdin.isTTY);
}

/** Print the orchestrator's questions (used before pausing non-interactively). */
export function printQuestions(questions: UserQuestion[]): void {
  console.log(chalk.bold("\n── The debug loop needs your input ──"));
  for (const q of questions) {
    console.log(chalk.cyan(`  ${q.id}: ${q.question}`));
  }
}

/** Ask each question on the TTY and collect answers. */
export async function askInteractively(
  questions: UserQuestion[],
): Promise<UserAnswer[]> {
  printQuestions(questions);
  const rl = readline.createInterface({ input, output });
  const answers: UserAnswer[] = [];
  try {
    for (const q of questions) {
      const answer = (await rl.question(chalk.cyan(`${q.id}> `))).trim();
      if (answer) {
        answers.push({ questionId: q.id, question: q.question, answer });
      }
    }
  } finally {
    rl.close();
  }
  return answers;
}

/** Zip positional --answer values against pending questions. */
export function matchAnswers(
  questions: UserQuestion[],
  provided: string[],
): UserAnswer[] {
  return provided
    .map((answer, i) => ({
      questionId: questions[i]?.id ?? `Q${i + 1}`,
      question: questions[i]?.question ?? "(unmatched answer)",
      answer: answer.trim(),
    }))
    .filter((a) => a.answer.length > 0);
}

/** Render answers as a prompt block appended to step prompts. */
export function userAnswersBlock(answers: UserAnswer[] | undefined): string {
  if (!answers?.length) return "";
  const lines = answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`);
  return `\n\nUser guidance (answers to the loop's earlier questions):\n${lines.join("\n")}`;
}
