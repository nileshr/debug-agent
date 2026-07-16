import type { z } from "zod";
import { AcpClient } from "../../acp/client.js";
import type { McpServerDef, SessionMode } from "../../acp/types.js";
import { resolveSpawnCwd } from "../../util/cwd.js";
import type { PermissionPolicyOptions } from "../permissions.js";
import { extractJsonFromText } from "../json-extract.js";
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
  mcpServers?: McpServerSpec[];
  permissionPolicy?: PermissionPolicyOptions;
  onEvent?: (ev: RuntimeEvent) => void;
  /** Agent subprocess command; defaults to Cursor's `agent acp`. */
  agentCommand?: string;
  agentArgs?: string[];
  requestTimeoutMs?: number;
  /**
   * Model the agent session is assumed to start with. Model hints matching this
   * value are not re-sent (mirrors the previous controller behavior of seeding
   * activeModel with the fixer model).
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

const CURSOR_CAPABILITIES: RuntimeCapabilities = {
  modes: true,
  modelSwitching: true,
  structuredOutput: false,
  planEvents: true,
  mcp: "file",
  askUser: true,
  sessionResume: true,
  oneShot: false,
};

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
 * ACP-backed AgentRuntime. Today this speaks to Cursor's `agent acp`
 * subprocess; generalized presets for other ACP agents land in a later phase.
 */
export class AcpRuntime implements AgentRuntime {
  readonly kind = "acp" as const;
  readonly client: AcpClient;
  private readonly options: AcpRuntimeOptions;
  private currentMode: string | null = null;
  private activeModel: string | null = null;
  private collector: string[] | null = null;

  constructor(options: AcpRuntimeOptions) {
    this.options = options;
    this.activeModel = options.initialModelId ?? null;
    const override = envAgentOverride();
    const agentCommand = override.command ?? options.agentCommand;
    const agentArgs = override.args ?? options.agentArgs;
    this.client = new AcpClient({
      // Only set keys when defined: AcpClient spreads its options over
      // defaults, so an explicit `undefined` would clobber them.
      ...(agentCommand !== undefined ? { agentCommand } : {}),
      ...(agentArgs !== undefined ? { agentArgs } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      spawnCwd: resolveSpawnCwd(options.repoPath),
      permissionPolicy: options.permissionPolicy,
      onStdoutChunk: (text) => {
        this.collector?.push(text);
        this.options.onEvent?.({ type: "text", text });
      },
      onTrace: (event) => {
        this.options.onEvent?.({ type: "trace", kind: event.kind, text: event.text });
      },
    });
  }

  capabilities(): RuntimeCapabilities {
    return { ...CURSOR_CAPABILITIES };
  }

  async start(): Promise<void> {
    await this.client.start();
    await this.client.initialize();
    await this.client.authenticate();
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
    return (this.options.mcpServers ?? []) as McpServerDef[];
  }

  async createSession(): Promise<RuntimeSession> {
    const result = await this.client.sessionNew({
      cwd: this.options.repoPath,
      mcpServers: this.mcpServersParam(),
    });
    this.currentMode = result.modes?.currentModeId ?? null;
    return new AcpRuntimeSession(this, result.sessionId);
  }

  async resumeSession(token: string): Promise<RuntimeSession> {
    const result = await this.client.sessionLoad({
      sessionId: token,
      cwd: this.options.repoPath,
      mcpServers: this.mcpServersParam(),
    });
    this.currentMode = result.modes?.currentModeId ?? null;
    return new AcpRuntimeSession(this, token);
  }

  async oneShot<T>(
    _promptText: string,
    _schema: z.ZodType<T>,
    _opts?: { model?: string },
  ): Promise<T | null> {
    throw new Error("oneShot is not supported by the ACP runtime yet");
  }

  private modeIdFor(mode: StepMode): SessionMode {
    return mode === "plan" ? "plan" : "agent";
  }

  async runPrompt<T>(
    sessionId: string,
    req: StepPromptRequest<T>,
  ): Promise<StepPromptResult<T>> {
    if (req.mode) {
      const modeId = this.modeIdFor(req.mode);
      if (modeId !== this.currentMode) {
        await this.client.setMode(sessionId, modeId);
        this.currentMode = modeId;
      }
    }
    if (req.model && req.model !== this.activeModel) {
      await this.client.setModel(sessionId, req.model);
      this.activeModel = req.model;
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
