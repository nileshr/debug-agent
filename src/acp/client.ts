import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import {
  type AcpClientEvent,
  type CursorAskQuestionParams,
  type CursorCreatePlanParams,
  type CursorTaskParams,
  type CursorUpdateTodosParams,
  type InitializeResult,
  type McpServerDef,
  type PendingRequest,
  type RequestPermissionParams,
  type SessionMode,
  type SessionNewResult,
  type SessionPromptResult,
  type SessionUpdateParams,
  InitializeResultSchema,
  SessionNewResultSchema,
  SessionLoadResultSchema,
  SessionPromptResultSchema,
} from "./types.js";
import {
  decidePermission,
  permissionResponse,
  type PermissionPolicyOptions,
} from "../permissions.js";
import { resolveSpawnCwd } from "../util/cwd.js";

export interface StreamUpdate {
  text: string;
  sessionUpdate?: string;
  contentType?: string;
}

export interface TraceEvent {
  kind: "message" | "tool" | "todo" | "task" | "plan";
  text: string;
}

export interface AcpClientOptions {
  agentCommand?: string;
  agentArgs?: string[];
  requestTimeoutMs?: number;
  /** cwd for the `agent acp` child process (defaults to a safe writable directory) */
  spawnCwd?: string;
  permissionPolicy?: PermissionPolicyOptions;
  onStdoutChunk?: (text: string) => void;
  onTrace?: (event: TraceEvent) => void;
}

export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly options: Required<
    Pick<AcpClientOptions, "agentCommand" | "agentArgs" | "requestTimeoutMs">
  > &
    AcpClientOptions;

  constructor(options: AcpClientOptions = {}) {
    super();
    this.options = {
      agentCommand: options.agentCommand ?? "agent",
      agentArgs: options.agentArgs ?? ["acp"],
      requestTimeoutMs: options.requestTimeoutMs ?? 600_000,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.child) return;

    this.child = spawn(this.options.agentCommand, this.options.agentArgs, {
      cwd: this.options.spawnCwd ?? resolveSpawnCwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.emit("stderr", text);
    });

    this.child.on("exit", (code) => {
      this.emit("exit", code);
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(`agent acp exited with code ${code ?? "unknown"}`));
      }
      this.pending.clear();
      this.child = null;
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
    this.child = null;
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("parse_error", line);
      return;
    }

    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;

    if (id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (msg.error) {
        const rpcErr = msg.error as {
          code?: number;
          message?: string;
          data?: unknown;
        };
        const detail =
          rpcErr.data != null ? ` ${JSON.stringify(rpcErr.data)}` : "";
        waiter.reject(new Error(`${rpcErr.message ?? "RPC error"}${detail}`));
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (method) {
      this.handleNotification(method, msg.params, id);
    }
  }

  private handleNotification(
    method: string,
    params: unknown,
    requestId: number | undefined,
  ): void {
    this.emit(method as AcpClientEvent, params);

    if (method === "session/update") {
      const update = params as SessionUpdateParams;
      const text = update?.update?.content?.text;
      const sessionUpdate = update?.update?.sessionUpdate;
      const contentType = update?.update?.content?.type;
      if (text) {
        this.options.onStdoutChunk?.(text);
        this.emit("stream", { text, sessionUpdate, contentType } satisfies StreamUpdate);

        const kind =
          sessionUpdate?.includes("tool") || contentType?.includes("tool")
            ? "tool"
            : "message";
        if (kind === "tool") {
          this.options.onTrace?.({ kind, text: truncateTrace(text) });
        }
      }
    }

    if (method === "session/request_permission" && requestId != null) {
      const permParams = params as RequestPermissionParams;
      if (permParams.toolName) {
        this.options.onTrace?.({
          kind: "tool",
          text: permParams.toolName,
        });
      }
      const policy = this.options.permissionPolicy;
      const decision = policy
        ? decidePermission(permParams, policy)
        : { outcome: "selected" as const, optionId: "allow-once" as const };
      this.respond(requestId, permissionResponse(requestId, decision).result);
    }

    if (method === "cursor/ask_question" && requestId != null) {
      this.respond(requestId, {
        outcome: { outcome: "skipped", reason: "automated debug-agent" },
      });
    }

    if (method === "cursor/create_plan" && requestId != null) {
      const planParams = params as CursorCreatePlanParams;
      if (planParams.name || planParams.overview) {
        this.options.onTrace?.({
          kind: "plan",
          text: planParams.name ?? planParams.overview ?? "Creating plan",
        });
      }
      this.respond(requestId, { outcome: { outcome: "accepted" } });
    }

    if (method === "cursor/update_todos") {
      const todoParams = params as CursorUpdateTodosParams;
      const active = todoParams.todos.find((t) => t.status === "in_progress");
      const done = todoParams.todos.filter((t) => t.status === "completed").length;
      const summary = active
        ? active.content
        : `${done}/${todoParams.todos.length} todos`;
      this.options.onTrace?.({ kind: "todo", text: summary });
    }

    if (method === "cursor/task" && requestId != null) {
      const taskParams = params as CursorTaskParams;
      this.options.onTrace?.({
        kind: "task",
        text: taskParams.description,
      });
      this.respond(requestId, {
        outcome: { outcome: "completed", durationMs: 0 },
      });
    }
  }

  private respond(id: number, result: unknown): void {
    if (!this.child) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    this.child.stdin.write(frame);
  }

  async send<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.start();
    if (!this.child) throw new Error("ACP client not started");

    const id = this.nextId++;
    const frame =
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    this.child.stdin.write(frame);

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method} (${this.options.requestTimeoutMs}ms)`));
        }
      }, this.options.requestTimeoutMs);
    });
  }

  async initialize(): Promise<InitializeResult> {
    const result = await this.send<unknown>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "debug-agent", version: "0.1.0" },
    });
    return InitializeResultSchema.parse(result);
  }

  async authenticate(methodId = "cursor_login"): Promise<void> {
    try {
      await this.send("authenticate", { methodId });
    } catch {
      // May already be logged in via agent login
    }
  }

  async sessionNew(params: {
    cwd: string;
    mcpServers?: McpServerDef[];
  }): Promise<SessionNewResult> {
    const result = await this.send<unknown>("session/new", params);
    return SessionNewResultSchema.parse(result);
  }

  async sessionLoad(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: McpServerDef[];
  }): Promise<SessionNewResult> {
    const result = await this.send<unknown>("session/load", params);
    SessionLoadResultSchema.parse(result);
    return SessionNewResultSchema.parse({
      sessionId: params.sessionId,
      ...(result as Record<string, unknown>),
    });
  }

  async sessionPrompt(params: {
    sessionId: string;
    prompt: Array<{ type: "text"; text: string }>;
  }): Promise<SessionPromptResult> {
    const result = await this.send<unknown>("session/prompt", params);
    return SessionPromptResultSchema.parse(result);
  }

  async sessionCancel(sessionId: string): Promise<void> {
    await this.send("session/cancel", { sessionId });
  }

  async setConfigOption(params: {
    sessionId: string;
    configId: string;
    value: string;
  }): Promise<void> {
    await this.send("session/set_config_option", params);
  }

  async setMode(sessionId: string, mode: SessionMode): Promise<void> {
    await this.setConfigOption({ sessionId, configId: "mode", value: mode });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.setConfigOption({ sessionId, configId: "model", value: modelId });
  }

  onAskQuestion(handler: (params: CursorAskQuestionParams) => void): this {
    return this.on("cursor/ask_question", handler);
  }

  onCreatePlan(handler: (params: CursorCreatePlanParams) => void): this {
    return this.on("cursor/create_plan", handler);
  }

  onUpdateTodos(handler: (params: CursorUpdateTodosParams) => void): this {
    return this.on("cursor/update_todos", handler);
  }

  onTask(handler: (params: CursorTaskParams) => void): this {
    return this.on("cursor/task", handler);
  }
}

function truncateTrace(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}
