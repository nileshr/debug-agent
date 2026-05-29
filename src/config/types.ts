import { z } from "zod";

export const BrowserMcpSchema = z.enum(["chrome-devtools", "playwright"]);
export type BrowserMcp = z.infer<typeof BrowserMcpSchema>;

export const AgentConfigSchema = z.object({
  version: z.literal(1),
  models: z.object({
    planner: z.string(),
    fixer: z.string(),
    reviewer: z.string(),
  }),
  browserMcp: BrowserMcpSchema,
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
  browserMcp?: BrowserMcp;
}
