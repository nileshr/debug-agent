import { z } from "zod";

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  method: z.string(),
  params: z.unknown().optional(),
});

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

export const SessionModeSchema = z.enum(["agent", "plan", "ask"]);

export const McpServerDefSchema = z.object({
  name: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

export type McpServerDef = z.infer<typeof McpServerDefSchema>;

export const InitializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentCapabilities: z.record(z.unknown()).optional(),
  authMethods: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

export const SessionNewResultSchema = z.object({
  sessionId: z.string(),
  modes: z
    .object({
      currentModeId: z.string(),
      availableModes: z.array(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
        }),
      ),
    })
    .optional(),
  models: z
    .object({
      currentModelId: z.string(),
      availableModels: z.array(
        z.object({
          modelId: z.string(),
          name: z.string().optional(),
        }),
      ),
    })
    .optional(),
  configOptions: z.array(z.unknown()).optional(),
});

export const SessionLoadResultSchema = SessionNewResultSchema.omit({ sessionId: true });

export const SessionPromptResultSchema = z.object({
  stopReason: z.string().optional(),
});

export const SessionUpdateParamsSchema = z.object({
  sessionId: z.string().optional(),
  update: z
    .object({
      sessionUpdate: z.string().optional(),
      content: z
        .object({
          type: z.string().optional(),
          text: z.string().optional(),
        })
        .optional(),
    })
    .passthrough()
    .optional(),
});

export const RequestPermissionParamsSchema = z.object({
  sessionId: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  options: z
    .array(
      z.object({
        optionId: z.string(),
        name: z.string().optional(),
        /** ACP spec option kind: allow_once | allow_always | reject_once | reject_always */
        kind: z.string().optional(),
      }),
    )
    .optional(),
});

/** Standard ACP plan entry (session/update with sessionUpdate: "plan"). */
export const AcpPlanEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
});

export type AcpPlanEntry = z.infer<typeof AcpPlanEntrySchema>;

export const CursorAskQuestionParamsSchema = z.object({
  toolCallId: z.string(),
  title: z.string().optional(),
  questions: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string() })),
      allowMultiple: z.boolean().optional(),
    }),
  ),
});

export const CursorCreatePlanParamsSchema = z.object({
  toolCallId: z.string(),
  name: z.string().optional(),
  overview: z.string().optional(),
  plan: z.string(),
  todos: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
    }),
  ),
  isProject: z.boolean().optional(),
});

export const CursorUpdateTodosParamsSchema = z.object({
  toolCallId: z.string(),
  todos: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
    }),
  ),
  merge: z.boolean(),
});

export const CursorTaskParamsSchema = z.object({
  toolCallId: z.string(),
  description: z.string(),
  prompt: z.string(),
  subagentType: z.union([
    z.enum([
      "unspecified",
      "computer_use",
      "explore",
      "video_review",
      "browser_use",
      "shell",
      "vm_setup_helper",
    ]),
    z.object({ custom: z.string() }),
  ]),
  model: z.string().optional(),
  agentId: z.string().optional(),
  durationMs: z.number().optional(),
});

export type SessionMode = z.infer<typeof SessionModeSchema>;
export type InitializeResult = z.infer<typeof InitializeResultSchema>;
export type SessionNewResult = z.infer<typeof SessionNewResultSchema>;
export type SessionLoadResult = z.infer<typeof SessionLoadResultSchema>;
export type SessionPromptResult = z.infer<typeof SessionPromptResultSchema>;
export type SessionUpdateParams = z.infer<typeof SessionUpdateParamsSchema>;
export type RequestPermissionParams = z.infer<typeof RequestPermissionParamsSchema>;
export type CursorAskQuestionParams = z.infer<typeof CursorAskQuestionParamsSchema>;
export type CursorCreatePlanParams = z.infer<typeof CursorCreatePlanParamsSchema>;
export type CursorUpdateTodosParams = z.infer<typeof CursorUpdateTodosParamsSchema>;
export type CursorTaskParams = z.infer<typeof CursorTaskParamsSchema>;

export type AcpClientEvent =
  | "session/update"
  | "session/request_permission"
  | "cursor/ask_question"
  | "cursor/create_plan"
  | "cursor/update_todos"
  | "cursor/task"
  | "cursor/generate_image"
  | "notification";

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  method: string;
}
