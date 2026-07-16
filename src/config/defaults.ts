import type { AgentConfig } from "./types.js";

/** Default agent preferences when no config file exists (non-interactive). */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  version: 2,
  models: {
    planner: "claude-opus-4-8-thinking-high",
    fixer: "composer-2.5[fast=true]",
    reviewer: "gpt-5.4-xhigh",
  },
  browserMcp: "playwright",
  runtime: "acp",
  autonomy: "static",
  acp: { preset: "cursor" },
};

/** Curated models for the interactive picker (ACP may expose more at runtime). */
export const CURATED_MODEL_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  {
    id: "claude-opus-4-8-thinking-high",
    label: "Claude Opus 4.8 thinking (high) — planner default",
  },
  { id: "gpt-5.4-xhigh", label: "GPT 5.4 xhigh — reviewer default" },
  { id: "composer-2.5[fast=true]", label: "Composer 2.5 fast — fixer default" },
  { id: "composer-2.5-fast", label: "Composer 2.5 fast (alt slug)" },
  { id: "claude-4.6-sonnet-medium-thinking", label: "Claude 4.6 Sonnet medium thinking" },
  { id: "gpt-5.5-medium", label: "GPT 5.5 medium" },
];

export const BROWSER_MCP_CHOICES: ReadonlyArray<{ id: AgentConfig["browserMcp"]; label: string }> =
  [
    {
      id: "playwright",
      label: "Playwright MCP (@playwright/mcp) — default",
    },
    {
      id: "chrome-devtools",
      label: "Chrome DevTools MCP (chrome-devtools-mcp)",
    },
  ];
