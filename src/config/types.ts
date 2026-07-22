import { z } from "zod";

export const BrowserMcpSchema = z.enum(["chrome-devtools", "playwright"]);
export type BrowserMcp = z.infer<typeof BrowserMcpSchema>;

export const RuntimeKindSchema = z.enum(["acp", "flue"]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const AutonomySchema = z.enum(["static", "guided", "autonomous"]);
export type Autonomy = z.infer<typeof AutonomySchema>;

export const AcpBlockSchema = z.object({
  preset: z
    .enum(["cursor", "claude", "codex", "gemini", "custom"])
    .default("cursor"),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
});
export type AcpBlock = z.infer<typeof AcpBlockSchema>;

export const AgentConfigSchema = z.object({
  /** v1 files (Cursor-only era) parse fine; new fields are additive. */
  version: z.union([z.literal(1), z.literal(2)]),
  models: z.object({
    planner: z.string(),
    fixer: z.string(),
    reviewer: z.string(),
    /** Orchestrator decisions (guided/autonomous); unset = heuristics only. */
    orchestrator: z.string().optional(),
  }),
  browserMcp: BrowserMcpSchema,
  runtime: RuntimeKindSchema.optional(),
  autonomy: AutonomySchema.optional(),
  acp: AcpBlockSchema.optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export interface ResolvedAgentConfig extends AgentConfig {
  /** Where each field was resolved from (for `debug config show`). */
  sources: {
    planner: ConfigSource;
    fixer: ConfigSource;
    reviewer: ConfigSource;
    browserMcp: ConfigSource;
  };
}

export type ConfigSource = "default" | "global" | "repo" | "cli";

export interface AgentConfigOverrides {
  planner?: string;
  fixer?: string;
  reviewer?: string;
  orchestrator?: string;
  browserMcp?: BrowserMcp;
  runtime?: RuntimeKind;
  autonomy?: Autonomy;
  agentPreset?: AcpBlock["preset"];
}
