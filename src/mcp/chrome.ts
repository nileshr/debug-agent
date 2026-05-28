import fs from "node:fs";
import path from "node:path";

/** MCP config entry for chrome-devtools-mcp (stdio). */
export const CHROME_DEVTOOLS_MCP_ENTRY = {
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@latest"],
} as const;

/**
 * ACP `session/new` only accepts `mcpServers: []` for inline definitions in practice;
 * project MCP servers must live in `.cursor/mcp.json`. This ensures chrome-devtools
 * is registered before the session starts.
 */
export function ensureChromeDevToolsMcpConfig(repoPath: string): void {
  const cursorDir = path.join(repoPath, ".cursor");
  const mcpPath = path.join(cursorDir, "mcp.json");

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

  if (!config.mcpServers!["chrome-devtools"]) {
    config.mcpServers!["chrome-devtools"] = { ...CHROME_DEVTOOLS_MCP_ENTRY };
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
}

/** Empty array — chrome-devtools is loaded from `.cursor/mcp.json`. */
export function acpMcpServersParam(): [] {
  return [];
}
