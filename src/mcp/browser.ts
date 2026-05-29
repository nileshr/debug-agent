import fs from "node:fs";
import path from "node:path";
import type { BrowserMcp } from "../config/types.js";

/** MCP config entry for chrome-devtools-mcp (stdio). */
export const CHROME_DEVTOOLS_MCP_ENTRY = {
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@latest"],
} as const;

/** MCP config entry for Playwright MCP (stdio). */
export const PLAYWRIGHT_MCP_ENTRY = {
  command: "npx",
  args: ["-y", "@playwright/mcp@latest"],
} as const;

const MCP_ENTRIES: Record<
  BrowserMcp,
  { command: string; args: readonly string[] }
> = {
  "chrome-devtools": CHROME_DEVTOOLS_MCP_ENTRY,
  playwright: PLAYWRIGHT_MCP_ENTRY,
};

const MCP_SERVER_KEYS: Record<BrowserMcp, string> = {
  "chrome-devtools": "chrome-devtools",
  playwright: "playwright",
};

/**
 * ACP `session/new` only accepts `mcpServers: []` for inline definitions in practice;
 * project MCP servers must live in `.cursor/mcp.json`. Ensures the selected browser
 * MCP server is registered before the session starts.
 */
export function ensureBrowserMcpConfig(
  repoPath: string,
  browserMcp: BrowserMcp = "chrome-devtools",
): void {
  const cursorDir = path.join(repoPath, ".cursor");
  const mcpPath = path.join(cursorDir, "mcp.json");
  const serverKey = MCP_SERVER_KEYS[browserMcp];
  const entry = MCP_ENTRIES[browserMcp];

  fs.mkdirSync(cursorDir, { recursive: true });

  let config: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };

  if (fs.existsSync(mcpPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as typeof config;
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      config = { mcpServers: {} };
    }
  }

  if (!config.mcpServers![serverKey]) {
    config.mcpServers![serverKey] = { ...entry };
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
}

/** @deprecated Use ensureBrowserMcpConfig */
export function ensureChromeDevToolsMcpConfig(repoPath: string): void {
  ensureBrowserMcpConfig(repoPath, "chrome-devtools");
}

/** Empty array — browser MCP is loaded from `.cursor/mcp.json`. */
export function acpMcpServersParam(): [] {
  return [];
}

export function browserMcpLabel(browserMcp: BrowserMcp): string {
  return browserMcp === "playwright" ? "Playwright MCP" : "Chrome DevTools MCP";
}
