import path from "node:path";
import type { RequestPermissionParams } from "../acp/types.js";

export type PermissionDecision =
  | { outcome: "selected"; optionId: "allow-once" | "allow-always" | "reject-once" }
  | { outcome: "cancelled" };

export interface PermissionPolicyOptions {
  repoPath: string;
  /** Auto-allow browser MCP tool calls (chrome-devtools and/or playwright) */
  allowBrowserMcp?: boolean;
}

const CHROME_TOOL_PREFIXES = [
  "chrome-devtools",
  "chrome_devtools",
  "mcp_chrome",
];

const PLAYWRIGHT_TOOL_PREFIXES = ["playwright", "mcp_playwright"];

function isUnderRepo(filePath: string, repoPath: string): boolean {
  const resolved = path.resolve(filePath);
  const repo = path.resolve(repoPath);
  return resolved === repo || resolved.startsWith(repo + path.sep);
}

function toolLooksLikeBrowserMcp(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return (
    CHROME_TOOL_PREFIXES.some((p) => lower.includes(p)) ||
    PLAYWRIGHT_TOOL_PREFIXES.some((p) => lower.includes(p)) ||
    lower.includes("browser_")
  );
}

/**
 * Default permission policy: allow read/edit/shell inside repo cwd and
 * chrome-devtools MCP tools; reject everything else.
 */
export function decidePermission(
  params: RequestPermissionParams,
  options: PermissionPolicyOptions,
): PermissionDecision {
  const { allowBrowserMcp = true } = options;
  const toolName = params.toolName ?? "";

  if (allowBrowserMcp && toolLooksLikeBrowserMcp(toolName)) {
    return { outcome: "selected", optionId: "allow-always" };
  }

  const targetPath =
    (params as { path?: string }).path ??
    (params as { filePath?: string }).filePath ??
    (params as { cwd?: string }).cwd;

  if (targetPath && !isUnderRepo(targetPath, options.repoPath)) {
    return { outcome: "selected", optionId: "reject-once" };
  }

  const optionsList = params.options ?? [];
  const hasAllowOnce = optionsList.some((o) => o.optionId === "allow-once");
  const hasAllowAlways = optionsList.some((o) => o.optionId === "allow-always");

  if (hasAllowOnce) {
    return { outcome: "selected", optionId: "allow-once" };
  }
  if (hasAllowAlways) {
    return { outcome: "selected", optionId: "allow-always" };
  }

  return { outcome: "selected", optionId: "allow-once" };
}

export function permissionResponse(
  requestId: number,
  decision: PermissionDecision,
): { jsonrpc: "2.0"; id: number; result: { outcome: PermissionDecision } } {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: { outcome: decision },
  };
}
