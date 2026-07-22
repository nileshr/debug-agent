import path from "node:path";
import type { RequestPermissionParams } from "../acp/types.js";

export type PermissionDecision =
  | { outcome: "selected"; optionId: string }
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

/** Runtime-agnostic permission verdict; adapters map it to protocol options. */
export type AbstractPermissionDecision = "allow" | "allow_always" | "reject";

/**
 * Default permission policy: allow read/edit/shell inside repo cwd and
 * browser MCP tools; reject everything else.
 */
export function decidePermissionAbstract(
  params: RequestPermissionParams,
  options: PermissionPolicyOptions,
): AbstractPermissionDecision {
  const { allowBrowserMcp = true } = options;

  if (allowBrowserMcp && toolLooksLikeBrowserMcp(params.toolName ?? "")) {
    return "allow_always";
  }

  const targetPath =
    (params as { path?: string }).path ??
    (params as { filePath?: string }).filePath ??
    (params as { cwd?: string }).cwd;

  if (targetPath && !isUnderRepo(targetPath, options.repoPath)) {
    return "reject";
  }

  return "allow";
}

const DECISION_KIND: Record<AbstractPermissionDecision, string> = {
  allow: "allow_once",
  allow_always: "allow_always",
  reject: "reject_once",
};

/** Cursor's literal option ids, used when the agent advertises no options. */
const DECISION_LEGACY_OPTION: Record<
  AbstractPermissionDecision,
  "allow-once" | "allow-always" | "reject-once"
> = {
  allow: "allow-once",
  allow_always: "allow-always",
  reject: "reject-once",
};

/**
 * Map an abstract verdict onto the agent's advertised permission options.
 * Preference order: matching spec `kind` → fuzzy optionId match → legacy
 * literal optionId (empty list) → first advertised option.
 */
export function selectPermissionOption(
  optionsList: NonNullable<RequestPermissionParams["options"]>,
  decision: AbstractPermissionDecision,
): PermissionDecision {
  if (optionsList.length === 0) {
    return { outcome: "selected", optionId: DECISION_LEGACY_OPTION[decision] };
  }

  const byKind = optionsList.find((o) => o.kind === DECISION_KIND[decision]);
  if (byKind) {
    return { outcome: "selected", optionId: byKind.optionId };
  }

  const lower = (s: string) => s.toLowerCase();
  const fuzzy =
    decision === "reject"
      ? optionsList.find((o) => lower(o.optionId).includes("reject"))
      : (decision === "allow"
          ? optionsList.find(
              (o) =>
                lower(o.optionId).includes("allow") &&
                lower(o.optionId).includes("once"),
            )
          : optionsList.find(
              (o) =>
                lower(o.optionId).includes("allow") &&
                lower(o.optionId).includes("always"),
            )) ?? optionsList.find((o) => lower(o.optionId).includes("allow"));
  if (fuzzy) {
    return { outcome: "selected", optionId: fuzzy.optionId };
  }

  return { outcome: "selected", optionId: optionsList[0].optionId };
}

/**
 * Historical combined entry point (decide + map). Behavior-compatible with the
 * pre-v2 Cursor-only implementation.
 */
export function decidePermission(
  params: RequestPermissionParams,
  options: PermissionPolicyOptions,
): PermissionDecision {
  return selectPermissionOption(
    params.options ?? [],
    decidePermissionAbstract(params, options),
  );
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
