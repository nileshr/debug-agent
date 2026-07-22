import type { StepMode } from "../types.js";

export type AcpPresetId = "cursor" | "claude" | "codex" | "gemini" | "custom";

export interface AcpAgentPreset {
  id: AcpPresetId;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Auth methodId to prefer when the agent advertises authMethods. */
  preferredAuthMethod?: string;
  /**
   * upfront: authenticate right after initialize, errors swallowed (Cursor's
   * historical behavior). on_demand: try session/new first, authenticate only
   * when it fails.
   */
  authStrategy: "upfront" | "on_demand";
  /** Map abstract step modes to this agent's mode ids. */
  modeMap?: Partial<Record<StepMode, string>>;
  /** inline: pass mcpServers to session/new; file: write a config file. */
  mcpStrategy: "inline" | "file";
  /** Enable cursor/* extension handling. */
  extensions: "cursor" | "none";
  /** Official ACP set_mode/set_model vs Cursor's set_config_option. */
  configTransport: "acp" | "cursor_config_option";
  /** Shown when authentication fails. */
  loginHint: string;
}

export const ACP_PRESETS: Record<AcpPresetId, AcpAgentPreset> = {
  cursor: {
    id: "cursor",
    command: "agent",
    args: ["acp"],
    preferredAuthMethod: "cursor_login",
    authStrategy: "upfront",
    modeMap: { plan: "plan", execute: "agent" },
    mcpStrategy: "file",
    extensions: "cursor",
    configTransport: "cursor_config_option",
    loginHint: "Run `agent login` (or set CURSOR_API_KEY).",
  },
  claude: {
    id: "claude",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
    authStrategy: "on_demand",
    modeMap: { plan: "plan", execute: "default" },
    mcpStrategy: "inline",
    extensions: "none",
    configTransport: "acp",
    loginHint: "Run `claude setup-token` or set ANTHROPIC_API_KEY.",
  },
  codex: {
    id: "codex",
    command: "codex-acp",
    args: [],
    authStrategy: "on_demand",
    mcpStrategy: "inline",
    extensions: "none",
    configTransport: "acp",
    loginHint: "Install codex-acp and authenticate (codex login).",
  },
  gemini: {
    id: "gemini",
    command: "gemini",
    args: ["--experimental-acp"],
    authStrategy: "on_demand",
    mcpStrategy: "inline",
    extensions: "none",
    configTransport: "acp",
    loginHint: "Run `gemini` once to sign in, or set GEMINI_API_KEY.",
  },
  custom: {
    id: "custom",
    command: "",
    args: [],
    authStrategy: "on_demand",
    mcpStrategy: "inline",
    extensions: "none",
    configTransport: "acp",
    loginHint: "Check your custom ACP agent's authentication.",
  },
};

export function isAcpPresetId(value: string): value is AcpPresetId {
  return value in ACP_PRESETS;
}

/** Resolve a preset with optional command/args overrides (custom agents). */
export function resolveAcpPreset(
  id: AcpPresetId,
  overrides?: { command?: string; args?: string[] },
): AcpAgentPreset {
  const base = ACP_PRESETS[id];
  const preset: AcpAgentPreset = {
    ...base,
    command: overrides?.command ?? base.command,
    args: overrides?.args ?? base.args,
  };
  if (preset.id === "custom" && !preset.command) {
    throw new Error(
      'ACP preset "custom" requires acp.command in config (or --help for flags).',
    );
  }
  return preset;
}
