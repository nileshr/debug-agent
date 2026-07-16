import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const MOCK_AGENT = path.join(PROJECT_ROOT, "scripts", "mock-acp-agent.mjs");

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface E2eEnv {
  home: string;
  repo: string;
  mockLog: string;
  cleanup: () => void;
}

/** Create an isolated HOME + target repo for an e2e run. */
export function makeE2eEnv(prefix = "dbg-e2e-"): E2eEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { test: "node -e ''" } }, null, 2),
  );
  fs.writeFileSync(
    path.join(repo, "src", "buggy.js"),
    "export function page(items, n) {\n  return items.slice(0, n + 1);\n}\n",
  );
  return {
    home,
    repo,
    mockLog: path.join(root, "mock-acp.jsonl"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export interface RunCliOptions {
  env: E2eEnv;
  args: string[];
  scenario: string;
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

/** Run the CLI from source (tsx) against the mock ACP agent. */
export async function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const { env, args, scenario, extraEnv, timeoutMs = 90_000 } = options;
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(PROJECT_ROOT, "src", "cli.ts"), ...args],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: env.home,
          DEBUG_AGENT_ACP_COMMAND: process.execPath,
          DEBUG_AGENT_ACP_ARGS: JSON.stringify([MOCK_AGENT, scenario]),
          MOCK_ACP_LOG: env.mockLog,
          NO_COLOR: "1",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `CLI timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Read the persisted repo ledger for the (single) run in a fixture repo. */
export function readLedger(repo: string): Record<string, unknown> {
  const dir = path.join(repo, ".debug-agent", "debug-runs");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length !== 1) {
    throw new Error(`expected exactly one ledger in ${dir}, found: ${files.join(", ")}`);
  }
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
}

export function readMockLog(env: E2eEnv): Array<{ method: string; params: unknown }> {
  if (!fs.existsSync(env.mockLog)) return [];
  return fs
    .readFileSync(env.mockLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
