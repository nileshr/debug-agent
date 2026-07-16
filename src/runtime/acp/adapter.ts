import type { z } from "zod";
import { AcpClient } from "../../acp/client.js";
import type {
  InitializeResult,
  McpServerDef,
  SessionNewResult,
} from "../../acp/types.js";
import { resolveSpawnCwd } from "../../util/cwd.js";
import type { PermissionPolicyOptions } from "../permissions.js";
import { extractJsonFromText } from "../json-extract.js";
import { ACP_PRESETS, type AcpAgentPreset } from "./presets.js";
import type {
  AgentRuntime,
  McpServerSpec,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  StepMode,
  StepPromptRequest,
  StepPromptResult,
  StepResultSource,
} from "../types.js";

export interface AcpRuntimeOptions {
  repoPath: string;
  /** Agent preset; defaults to Cursor (historical behavior). */
  preset?: AcpAgentPreset;
  mcpServers?: McpServerSpec[];
  permissionPolicy?: PermissionPolicyOptions;
  onEvent?: (ev: RuntimeEvent) => void;
  /** One-line diagnostics (skipped capabilities, auth fallbacks). */
  onWarn?: (message: string) => void;
  requestTimeoutMs?: number;
  /**
   * Model the agent session is assumed to start with. Model hints matching
   * this value are not re-sent (mirrors the previous controller behavior of
   * seeding activeModel with the fixer model).
   */
  initialModelId?: string;
}

/** Test/dev override for the spawned ACP agent (used by the mock-agent e2e suite). */
function envAgentOverride(): { command?: string; args?: string[] } {
  const command = process.env.DEBUG_AGENT_ACP_COMMAND;
  if (!command) return {};
  const rawArgs = process.env.DEBUG_AGENT_ACP_ARGS;
  let args: string[] | undefined;
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (Array.isArray(parsed)) args = parsed.map(String);
    } catch {
      args = rawArgs.split(" ").filter(Boolean);
    }
  }
  return { command, args };
}

function mapStopReason(
  stopReason: string | undefined,
): StepPromptResult["stopReason"] {
  switch (stopReason) {
    case "end_turn":
    case "cancelled":
    case "refusal":
    case "error":
      return stopReason;
    default:
      return "unknown";
  }
}

class AcpRuntimeSession implements RuntimeSession {
  constructor(
    private readonly runtime: AcpRuntime,
    readonly sessionId: string,
  ) {}

  resumeToken(): string | null {
    return this.sessionId;
  }

  async prompt<T = unknown>(
    req: StepPromptRequest<T>,
  ): Promise<StepPromptResult<T>> {
    return this.runtime.runPrompt(this.sessionId, req);
  }

  async cancel(): Promise<void> {
    await this.runtime.client.sessionCancel(this.sessionId);
  }
}

/**
 * ACP-backed AgentRuntime. Speaks to any ACP agent subprocess selected by an
 * AcpAgentPreset (Cursor, claude-agent-acp, codex-acp, gemini, custom), with
 * capability discovery from the initialize and session/new responses.
 */
export class AcpRuntime implements AgentRuntime {
  readonly kind = "acp" as const;
  readonly client: AcpClient;
  readonly preset: AcpAgentPreset;
  private readonly options: AcpRuntimeOptions;
  private currentMode: string | null = null;
  private activeModel: string | null = null;
  private collector: string[] | null = null;
  private initResult: InitializeResult | null = null;
  private authenticated = false;
  private availableModes: string[] = [];
  private availableModels: string[] = [];
  private modesDiscovered = false;
  private modelsDiscovered = false;
  private readonly warnedOnce = new Set<string>();

  constructor(options: AcpRuntimeOptions) {
    this.options = options;
    this.preset = options.preset ?? ACP_PRESETS.cursor;
    this.activeModel = options.initialModelId ?? null;
    const override = envAgentOverride();
    const agentCommand = override.command ?? this.preset.command;
    const agentArgs = override.args ?? this.preset.args;
    this.client = new AcpClient({
      agentCommand,
      agentArgs,
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      spawnCwd: resolveSpawnCwd(options.repoPath),
      permissionPolicy: options.permissionPolicy,
      cursorExtensions: this.preset.extensions === "cursor",
      onStdoutChunk: (text) => {
        this.collector?.push(text);
        this.options.onEvent?.({ type: "text", text });
      },
      onTrace: (event) => {
        this.options.onEvent?.({ type: "trace", kind: event.kind, text: event.text });
      },
      onPlan: (entries) => {
        this.options.onEvent?.({
          type: "plan",
          entries: entries.map((e, i) => ({
            id: `P${i + 1}`,
            content: e.content,
            status: e.status ?? "pending",
            priority: e.priority,
          })),
        });
      },
    });
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.options.onWarn?.(message);
  }

  capabilities(): RuntimeCapabilities {
    const agentCaps = (this.initResult?.agentCapabilities ?? {}) as {
      loadSession?: boolean;
    };
    return {
      modes: this.modesDiscovered || Boolean(this.preset.modeMap),
      modelSwitching:
        this.preset.configTransport === "cursor_config_option" ||
        this.modelsDiscovered,
      structuredOutput: false,
      planEvents: true,
      mcp: this.preset.mcpStrategy,
      askUser: this.preset.extensions === "cursor",
      sessionResume:
        this.preset.id === "cursor" ? true : Boolean(agentCaps.loadSession),
      oneShot: false,
    };
  }

  async start(): Promise<void> {
    await this.client.start();
    this.initResult = await this.client.initialize();
    if (this.preset.authStrategy === "upfront") {
      await this.client.authenticate(
        this.preset.preferredAuthMethod ?? "cursor_login",
      );
      this.authenticated = true;
    }
    this.client.onUpdateTodos((params) => {
      this.options.onEvent?.({
        type: "plan",
        entries: params.todos.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status,
        })),
      });
    });
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  private mcpServersParam(): McpServerDef[] {
    if (this.preset.mcpStrategy !== "inline") return [];
    return (this.options.mcpServers ?? []) as McpServerDef[];
  }

  /** Pick the auth method to try: preferred if advertised, else first advertised. */
  private pickAuthMethod(): string | null {
    const advertised = this.initResult?.authMethods?.map((m) => m.id) ?? [];
    if (
      this.preset.preferredAuthMethod &&
      (advertised.length === 0 ||
        advertised.includes(this.preset.preferredAuthMethod))
    ) {
      return this.preset.preferredAuthMethod;
    }
    return advertised[0] ?? null;
  }

  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (this.authenticated) throw err;
      const methodId = this.pickAuthMethod();
      if (!methodId) {
        throw new Error(
          `${(err as Error).message}\nAgent may require authentication. ${this.preset.loginHint}`,
        );
      }
      try {
        await this.client.authenticateStrict(methodId);
      } catch (authErr) {
        throw new Error(
          `Authentication failed (${methodId}): ${(authErr as Error).message}\n${this.preset.loginHint}`,
        );
      }
      this.authenticated = true;
      return await fn();
    }
  }

  private absorbSessionInfo(result: SessionNewResult): void {
    if (result.modes) {
      this.modesDiscovered = true;
      this.currentMode = result.modes.currentModeId;
      this.availableModes = result.modes.availableModes.map((m) => m.id);
    }
    if (result.models) {
      this.modelsDiscovered = true;
      this.availableModels = result.models.availableModels.map((m) => m.modelId);
    }
  }

  async createSession(): Promise<RuntimeSession> {
    const result = await this.withAuthRetry(() =>
      this.client.sessionNew({
        cwd: this.options.repoPath,
        mcpServers: this.mcpServersParam(),
      }),
    );
    this.absorbSessionInfo(result);
    return new AcpRuntimeSession(this, result.sessionId);
  }

  async resumeSession(token: string): Promise<RuntimeSession> {
    const result = await this.withAuthRetry(() =>
      this.client.sessionLoad({
        sessionId: token,
        cwd: this.options.repoPath,
        mcpServers: this.mcpServersParam(),
      }),
    );
    this.absorbSessionInfo(result);
    return new AcpRuntimeSession(this, token);
  }

  async oneShot<T>(
    _promptText: string,
    _schema: z.ZodType<T>,
    _opts?: { model?: string },
  ): Promise<T | null> {
    throw new Error("oneShot is not supported by the ACP runtime yet");
  }

  /** Map an abstract step mode to this agent's mode id (preset map → fuzzy). */
  private modeIdFor(mode: StepMode): string | null {
    const mapped = this.preset.modeMap?.[mode];
    if (mapped) {
      if (this.availableModes.length === 0 || this.availableModes.includes(mapped)) {
        return mapped;
      }
    }
    if (this.availableModes.length > 0) {
      if (mode === "plan") {
        return this.availableModes.find((m) => m.toLowerCase().includes("plan")) ?? null;
      }
      return (
        this.availableModes.find((m) => m === "agent" || m === "default") ??
        this.availableModes.find((m) => !m.toLowerCase().includes("plan")) ??
        null
      );
    }
    return mapped ?? null;
  }

  private async applyMode(sessionId: string, mode: StepMode): Promise<void> {
    const modeId = this.modeIdFor(mode);
    if (!modeId) {
      this.warnOnce("modes", `Agent does not expose a "${mode}" mode; continuing without mode switching.`);
      return;
    }
    if (modeId === this.currentMode) return;
    if (this.preset.configTransport === "cursor_config_option") {
      await this.client.setMode(sessionId, modeId as "agent" | "plan" | "ask");
    } else {
      await this.client.setSessionMode(sessionId, modeId);
    }
    this.currentMode = modeId;
  }

  private async applyModel(sessionId: string, modelId: string): Promise<void> {
    if (modelId === this.activeModel) return;
    if (this.preset.configTransport === "cursor_config_option") {
      await this.client.setModel(sessionId, modelId);
      this.activeModel = modelId;
      return;
    }
    if (!this.modelsDiscovered) {
      this.warnOnce(
        "models",
        "Agent does not advertise model switching; using its default model.",
      );
      return;
    }
    if (!this.availableModels.includes(modelId)) {
      this.warnOnce(
        `model:${modelId}`,
        `Model "${modelId}" not offered by this agent; keeping its current model.`,
      );
      return;
    }
    await this.client.setSessionModel(sessionId, modelId);
    this.activeModel = modelId;
  }

  async runPrompt<T>(
    sessionId: string,
    req: StepPromptRequest<T>,
  ): Promise<StepPromptResult<T>> {
    if (req.mode) {
      await this.applyMode(sessionId, req.mode);
    }
    if (req.model) {
      await this.applyModel(sessionId, req.model);
    }

    const collected: string[] = [];
    this.collector = collected;
    let stopReason: StepPromptResult["stopReason"];
    try {
      const result = await this.client.sessionPrompt({
        sessionId,
        prompt: [{ type: "text", text: req.text }],
      });
      stopReason = mapStopReason(result.stopReason);
    } finally {
      this.collector = null;
    }

    const rawText = collected.join("");
    let data: T | null = null;
    let dataSource: StepResultSource = "none";
    if (req.resultSchema) {
      const candidate = extractJsonFromText<unknown>(rawText);
      if (candidate != null) {
        const parsed = req.resultSchema.safeParse(candidate);
        if (parsed.success) {
          data = parsed.data;
          dataSource = "json_extraction";
        }
      }
    }

    return { stopReason, data, dataSource, rawText };
  }
}
