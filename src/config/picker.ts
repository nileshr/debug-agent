import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { BROWSER_MCP_CHOICES, DEFAULT_AGENT_CONFIG } from "./defaults.js";
import { fetchModelChoices, type ModelChoice } from "./fetch-models.js";
import { saveGlobalConfig } from "./store.js";
import type { AgentConfig, BrowserMcp } from "./types.js";

function defaultIndexFor(
  choices: ModelChoice[],
  preferredId: string,
): number {
  const idx = choices.findIndex((c) => c.id === preferredId);
  return idx >= 0 ? idx + 1 : 1;
}

function printNumberedList(choices: ModelChoice[], defaultNum: number): void {
  for (let i = 0; i < choices.length; i++) {
    const num = i + 1;
    const mark = num === defaultNum ? chalk.green(" (default)") : "";
    console.log(`  ${chalk.cyan(String(num))}. ${choices[i].label}${mark}`);
  }
}

async function pickFromList(
  rl: readline.Interface,
  title: string,
  choices: ModelChoice[],
  defaultNum: number,
): Promise<string> {
  console.log(chalk.bold(`\n${title}`));
  printNumberedList(choices, defaultNum);
  const answer = await rl.question(
    chalk.dim(`Choice [${defaultNum}]: `),
  );
  const trimmed = answer.trim();
  if (!trimmed) return choices[defaultNum - 1].id;
  const num = parseInt(trimmed, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= choices.length) {
    return choices[num - 1].id;
  }
  const byId = choices.find((c) => c.id === trimmed);
  if (byId) return byId.id;
  console.log(chalk.yellow("Unrecognized choice; using default."));
  return choices[defaultNum - 1].id;
}

async function pickBrowserMcp(rl: readline.Interface): Promise<BrowserMcp> {
  console.log(chalk.bold("\nBrowser MCP (for --url / Vite browser verification)"));
  const defaultNum = 1;
  for (let i = 0; i < BROWSER_MCP_CHOICES.length; i++) {
    const num = i + 1;
    const mark = num === defaultNum ? chalk.green(" (default)") : "";
    console.log(`  ${chalk.cyan(String(num))}. ${BROWSER_MCP_CHOICES[i].label}${mark}`);
  }
  const answer = await rl.question(chalk.dim(`Choice [${defaultNum}]: `));
  const trimmed = answer.trim();
  if (!trimmed) return BROWSER_MCP_CHOICES[defaultNum - 1].id;
  const num = parseInt(trimmed, 10);
  if (num === 1) return "playwright";
  if (num === 2) return "chrome-devtools";
  if (trimmed === "playwright" || trimmed === "chrome-devtools") {
    return trimmed;
  }
  return BROWSER_MCP_CHOICES[defaultNum - 1].id;
}

export interface RunInteractivePickerOptions {
  repoPath: string;
  /** When true, write result to ~/.debug-agent/config.json */
  saveGlobal?: boolean;
}

/**
 * Interactive first-run setup. Returns config; optionally persists globally.
 */
export async function runInteractivePicker(
  options: RunInteractivePickerOptions,
): Promise<AgentConfig> {
  console.log(
    chalk.bold("\ndebug-agent: configure models and browser MCP\n") +
      chalk.dim(
        "Separate models for planning (hypothesize), fixing (most phases), and code review.\n",
      ),
  );

  const modelChoices = await fetchModelChoices(options.repoPath);
  const rl = readline.createInterface({ input, output });

  try {
    const planner = await pickFromList(
      rl,
      "Planner model (hypothesize / plan mode)",
      modelChoices,
      defaultIndexFor(modelChoices, DEFAULT_AGENT_CONFIG.models.planner),
    );
    const fixer = await pickFromList(
      rl,
      "Fixer model (instrument, fix, verify, …)",
      modelChoices,
      defaultIndexFor(modelChoices, DEFAULT_AGENT_CONFIG.models.fixer),
    );
    const reviewer = await pickFromList(
      rl,
      "Reviewer model (code review phase)",
      modelChoices,
      defaultIndexFor(modelChoices, DEFAULT_AGENT_CONFIG.models.reviewer),
    );
    const browserMcp = await pickBrowserMcp(rl);

    const config: AgentConfig = {
      version: 1,
      models: { planner, fixer, reviewer },
      browserMcp,
    };

    if (options.saveGlobal !== false) {
      const saved = saveGlobalConfig(config);
      console.log(chalk.green(`\nSaved global config: ${saved}`));
      console.log(
        chalk.dim(
          "Optional repo override: .debug-agent/config.json (merged over global).\n",
        ),
      );
    }

    return config;
  } finally {
    rl.close();
  }
}
