import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { AcpClient } from "../acp/client.js";
import {
  acpMcpServersParam,
  CHROME_DEVTOOLS_ALLOW_PROMPT_MESSAGE,
} from "../mcp/browser.js";
import { resolveAgentConfig } from "../config/resolve.js";
import { REPORTS_DIR } from "../report/emit.js";
import {
  isDirectoryAccessible,
  resolveSpawnCwd,
  tryProcessCwd,
} from "../util/cwd.js";
import type { CheckResult } from "./types.js";

const execFileAsync = promisify(execFile);

function pass(id: string, name: string, message: string): CheckResult {
  return { id, name, status: "pass", message };
}

function warn(
  id: string,
  name: string,
  message: string,
  suggestion: string,
): CheckResult {
  return { id, name, status: "warn", message, suggestion };
}

function fail(
  id: string,
  name: string,
  message: string,
  suggestion: string,
): CheckResult {
  return { id, name, status: "fail", message, suggestion };
}

async function commandExists(cmd: string): Promise<string | null> {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(which, [cmd], { timeout: 5000 });
    const line = stdout.trim().split("\n")[0];
    return line || null;
  } catch {
    return null;
  }
}

async function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 15_000,
  cwd = resolveSpawnCwd(),
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, stdout, stderr: stderr + "\n(timeout)" });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr });
    });
  });
}

export async function checkWorkingDirectory(
  repoPath?: string,
): Promise<CheckResult> {
  const cwd = tryProcessCwd();
  if (cwd && isDirectoryAccessible(cwd)) {
    return pass("cwd", "Working directory", cwd);
  }

  const fallback = resolveSpawnCwd(repoPath);
  const message = cwd
    ? `Cannot access ${cwd} (permission denied)`
    : "Current directory unavailable (EPERM)";
  return warn(
    "cwd",
    "Working directory",
    message,
    `cd to an accessible folder or pass --repo. Commands run with cwd ${fallback}.`,
  );
}

export async function checkNode(): Promise<CheckResult> {
  const major = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 20) {
    return pass("node", "Node.js", `v${process.versions.node} (>= 20)`);
  }
  return fail(
    "node",
    "Node.js",
    `v${process.versions.node} — need Node 20+`,
    "Install Node 20+ from https://nodejs.org or use nvm: nvm install 20",
  );
}

export async function checkAgentCli(): Promise<CheckResult> {
  const agentPath = await commandExists("agent");
  if (!agentPath) {
    return fail(
      "agent-cli",
      "Cursor CLI (`agent`)",
      "Not found on PATH",
      "Install: curl https://cursor.com/install -fsS | bash\nThen ensure ~/.local/bin is on your PATH.",
    );
  }

  const ver = await runCommand("agent", ["--version"], 10_000);
  const version = ver.stdout.trim();
  if (ver.ok && version) {
    return pass("agent-cli", "Cursor CLI (`agent`)", `${agentPath} (${version})`);
  }
  const detail = (ver.stderr || ver.stdout).trim().slice(0, 160);
  return warn(
    "agent-cli",
    "Cursor CLI (`agent`)",
    detail
      ? `Found at ${agentPath} but \`agent --version\` failed: ${detail}`
      : `Found at ${agentPath} but could not read version`,
    "Run `agent --version` from an accessible directory. If cwd is restricted, cd elsewhere and retry.",
  );
}

export async function checkAuth(): Promise<CheckResult> {
  if (process.env.CURSOR_API_KEY?.trim()) {
    return pass(
      "auth",
      "Cursor auth",
      "CURSOR_API_KEY is set",
    );
  }

  const whoami = await runCommand("agent", ["whoami"], 12_000);
  if (whoami.ok) {
    const identity = (whoami.stdout || whoami.stderr).trim().split("\n")[0];
    if (identity) {
      return pass("auth", "Cursor auth", `agent whoami: ${identity}`);
    }
  }

  const cursorDir = path.join(os.homedir(), ".cursor");
  if (!fs.existsSync(cursorDir)) {
    return fail(
      "auth",
      "Cursor auth",
      "Not logged in (`agent whoami` failed) and no CURSOR_API_KEY",
      "Run `agent login` in your terminal, or export CURSOR_API_KEY from Cursor → Integrations.",
    );
  }

  const detail = (whoami.stderr || whoami.stdout).trim().slice(0, 120);
  return warn(
    "auth",
    "Cursor auth",
    detail
      ? `~/.cursor present; agent whoami failed: ${detail}`
      : "Using local Cursor login (agent whoami unavailable)",
    "If ACP auth fails, run `agent login` or set CURSOR_API_KEY.",
  );
}

export async function checkAcpAuth(repoPath?: string): Promise<CheckResult> {
  const client = new AcpClient({
    requestTimeoutMs: 25_000,
    spawnCwd: resolveSpawnCwd(repoPath),
  });
  try {
    await client.start();
    await client.initialize();
    await client.authenticate();
    return pass("acp-auth", "ACP authenticate", "cursor_login succeeded");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return fail(
      "acp-auth",
      "ACP authenticate",
      `Failed: ${msg.slice(0, 200)}`,
      "Run `agent login`, then retry `debug setup`. Or set CURSOR_API_KEY.",
    );
  } finally {
    await client.stop();
  }
}

export async function checkAcpModes(repoPath?: string): Promise<CheckResult> {
  const sessionCwd = resolveSpawnCwd(repoPath);
  const client = new AcpClient({
    requestTimeoutMs: 25_000,
    spawnCwd: sessionCwd,
  });
  try {
    await client.start();
    await client.initialize();
    await client.authenticate();
    const session = await client.sessionNew({
      cwd: sessionCwd,
      mcpServers: acpMcpServersParam(),
    });
    const modes =
      session.modes?.availableModes?.map((m) => m.id).join(", ") ?? "unknown";
    const hasDebug = modes.includes("debug");
    if (hasDebug) {
      return warn(
        "acp-modes",
        "ACP modes",
        `Available: ${modes} (debug present)`,
        "Native debug mode may be usable; this tool still emulates the loop by default.",
      );
    }
    return pass(
      "acp-modes",
      "ACP modes",
      `${modes} — debug not exposed (emulation required)`,
    );
  } catch (err) {
    return fail(
      "acp-modes",
      "ACP session",
      (err as Error).message?.slice(0, 200) ?? "session/new failed",
      "Run `agent --debug acp` for details. Ensure `agent login` completed.",
    );
  } finally {
    await client.stop();
  }
}

export async function checkNpx(): Promise<CheckResult> {
  const npxPath = await commandExists("npx");
  if (!npxPath) {
    return fail(
      "npx",
      "npx",
      "Not found on PATH",
      "Comes with Node/npm. Reinstall Node or ensure npm global bin is on PATH.",
    );
  }
  return pass("npx", "npx", npxPath);
}

export async function checkChromeDevToolsMcp(): Promise<CheckResult> {
  const result = await runCommand(
    "npx",
    ["-y", "chrome-devtools-mcp@latest", "--help"],
    60_000,
  );
  if (result.ok || result.stdout.includes("chrome") || result.stderr.includes("Usage")) {
    return pass(
      "chrome-mcp",
      "chrome-devtools-mcp",
      "Package reachable via npx (first run may download)",
    );
  }
  return fail(
    "chrome-mcp",
    "chrome-devtools-mcp",
    `Could not run: ${(result.stderr || result.stdout).slice(0, 120)}`,
    "Check network and npm registry. Try: npx -y chrome-devtools-mcp@latest --help",
  );
}

export async function checkChromeBrowser(): Promise<CheckResult> {
  if (process.platform === "darwin") {
    const chromeApp = "/Applications/Google Chrome.app";
    if (fs.existsSync(chromeApp)) {
      return pass("chrome", "Google Chrome", "Installed (macOS)");
    }
    const chromium = "/Applications/Chromium.app";
    if (fs.existsSync(chromium)) {
      return warn(
        "chrome",
        "Google Chrome",
        "Chromium found; Chrome preferred for devtools MCP",
        "Install Google Chrome for best compatibility with chrome-devtools-mcp.",
      );
    }
    return fail(
      "chrome",
      "Google Chrome",
      "Not found in /Applications",
      "Install Google Chrome. chrome-devtools-mcp launches Chrome to reproduce bugs.",
    );
  }

  if (process.platform === "linux") {
    const bins = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
    for (const b of bins) {
      const p = await commandExists(b);
      if (p) return pass("chrome", "Chrome/Chromium", p);
    }
    return fail(
      "chrome",
      "Google Chrome",
      "No chrome/chromium binary on PATH",
      "Install google-chrome or chromium. Example: sudo apt install google-chrome-stable",
    );
  }

  if (process.platform === "win32") {
    const paths = [
      path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    for (const p of paths) {
      if (p && fs.existsSync(p)) return pass("chrome", "Google Chrome", p);
    }
    return warn(
      "chrome",
      "Google Chrome",
      "Could not locate chrome.exe automatically",
      "Install Chrome if reproduction fails. MCP may still find a browser.",
    );
  }

  return warn("chrome", "Google Chrome", "Skipped on this platform", "Ensure a Chromium-based browser is installed.");
}

export async function checkReportsDir(): Promise<CheckResult> {
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const probe = path.join(REPORTS_DIR, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return pass("reports-dir", "Report output dir", REPORTS_DIR);
  } catch (err) {
    return fail(
      "reports-dir",
      "Report output dir",
      `Cannot write to ${REPORTS_DIR}: ${(err as Error).message}`,
      `mkdir -p ${REPORTS_DIR} and check permissions.`,
    );
  }
}

export async function checkChromeDevToolsAllowPrompt(
  repoPath?: string,
): Promise<CheckResult | null> {
  const { browserMcp } = resolveAgentConfig({
    repoPath: repoPath ?? resolveSpawnCwd(repoPath),
    warnOnIssues: false,
  });
  if (browserMcp !== "chrome-devtools") return null;

  return warn(
    "chrome-allow",
    "Chrome DevTools MCP",
    CHROME_DEVTOOLS_ALLOW_PROMPT_MESSAGE,
    "Default is Playwright (no Allow prompt): debug config set --browser-mcp playwright",
  );
}

export async function checkRepoMcp(repoPath: string): Promise<CheckResult> {
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) {
    return fail(
      "repo-mcp",
      "Target repo",
      `Path does not exist: ${resolved}`,
      "Pass a valid repo path: debug setup --repo /path/to/project",
    );
  }

  const mcpPath = path.join(resolved, ".cursor", "mcp.json");
  if (!fs.existsSync(mcpPath)) {
    return warn(
      "repo-mcp",
      "Repo MCP config",
      `No ${mcpPath} yet`,
      "First browser `debug run` adds chrome-devtools or playwright to .cursor/mcp.json (see `debug config`).",
    );
  }

  try {
    const config = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const chrome = config.mcpServers?.["chrome-devtools"];
    const playwright = config.mcpServers?.["playwright"];
    if (chrome?.command === "npx") {
      return pass(
        "repo-mcp",
        "Repo MCP config",
        `chrome-devtools configured in .cursor/mcp.json`,
      );
    }
    if (playwright?.command === "npx") {
      return pass(
        "repo-mcp",
        "Repo MCP config",
        `playwright configured in .cursor/mcp.json`,
      );
    }
    return warn(
      "repo-mcp",
      "Repo MCP config",
      "mcp.json exists but no chrome-devtools or playwright npx entry",
      'Add chrome-devtools or playwright per `debug config` / docs/INSTALL.md.',
    );
  } catch (err) {
    return fail(
      "repo-mcp",
      "Repo MCP config",
      `Invalid ${mcpPath}: ${(err as Error).message}`,
      "Fix JSON syntax or delete the file and re-run debug-agent.",
    );
  }
}

export interface RunChecksOptions {
  repoPath?: string;
  /** Skip live ACP session probe (faster) */
  skipAcpProbe?: boolean;
}

export async function runAllChecks(
  options: RunChecksOptions = {},
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  checks.push(await checkWorkingDirectory(options.repoPath));
  checks.push(await checkNode());
  checks.push(await checkAgentCli());
  checks.push(await checkAuth());
  checks.push(await checkNpx());
  checks.push(await checkChromeBrowser());
  checks.push(await checkChromeDevToolsMcp());
  checks.push(await checkReportsDir());

  const chromeAllow = await checkChromeDevToolsAllowPrompt(options.repoPath);
  if (chromeAllow) checks.push(chromeAllow);

  if (!options.skipAcpProbe) {
    checks.push(await checkAcpAuth(options.repoPath));
    checks.push(await checkAcpModes(options.repoPath));
  }

  if (options.repoPath) {
    checks.push(await checkRepoMcp(options.repoPath));
  }

  return checks;
}
