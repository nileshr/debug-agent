import type { z } from "zod";

/** Logical model roles the loop assigns to steps; config resolves them to concrete model ids. */
export type ModelRole = "planner" | "fixer" | "reviewer" | "orchestrator";

/** Abstract step mode; adapters map to runtime-specific modes or ignore when unsupported. */
export type StepMode = "plan" | "execute";

export interface RuntimeCapabilities {
  /** Runtime can switch between a read-only/planning mode and an editing mode. */
  modes: boolean;
  /** Runtime can switch model mid-session (per step). */
  modelSwitching: boolean;
  /** Runtime returns schema-validated results natively (no fenced-JSON scraping). */
  structuredOutput: boolean;
  /** Runtime emits native plan/todo progress events. */
  planEvents: boolean;
  /** How MCP servers are provided to the runtime. */
  mcp: "inline" | "file" | "none";
  /** Runtime/agent can surface questions to the user mid-prompt. */
  askUser: boolean;
  /** Sessions can be resumed after process restart. */
  sessionResume: boolean;
  /** Cheap one-shot LLM calls (orchestrator decisions) are available. */
  oneShot: boolean;
}

export interface PlanEntry {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

/** Trace kinds mirror the ledger's TraceKind (minus the loop-generated "phase"). */
export type RuntimeTraceKind = "message" | "tool" | "todo" | "task" | "plan";

export type RuntimeEvent =
  | { type: "text"; text: string }
  | { type: "trace"; kind: RuntimeTraceKind; text: string }
  | { type: "plan"; entries: PlanEntry[] };

export interface McpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface StepPromptRequest<T = unknown> {
  text: string;
  /** Exit contract for this step; adapters return validated data when possible. */
  resultSchema?: z.ZodType<T>;
  /** Mode hint; ignored when !capabilities.modes. */
  mode?: StepMode;
  /** Concrete model id; ignored when !capabilities.modelSwitching. */
  model?: string;
  timeoutMs?: number;
}

export type StepResultSource = "structured" | "json_extraction" | "none";

export interface StepPromptResult<T = unknown> {
  stopReason: "end_turn" | "cancelled" | "refusal" | "error" | "unknown";
  /** Validated result, or null when unparsable/invalid or no schema was given. */
  data: T | null;
  /** Where `data` came from — recorded for auditability. */
  dataSource: StepResultSource;
  /** Accumulated agent text streamed during this prompt. */
  rawText: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface RuntimeSession {
  readonly sessionId: string;
  /** Opaque token persisted in the ledger; enables resumeSession across restarts. */
  resumeToken(): string | null;
  prompt<T = unknown>(req: StepPromptRequest<T>): Promise<StepPromptResult<T>>;
  cancel(): Promise<void>;
}

export interface AgentRuntime {
  readonly kind: "acp" | "flue";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Valid after start(); adapters may refine after session creation. */
  capabilities(): RuntimeCapabilities;
  createSession(): Promise<RuntimeSession>;
  resumeSession(token: string): Promise<RuntimeSession>;
  /**
   * Cheap single-turn structured call for orchestrator decisions.
   * Only usable when capabilities().oneShot is true.
   */
  oneShot<T>(
    promptText: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    opts?: { model?: string },
  ): Promise<T | null>;
}
