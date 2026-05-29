import { z } from "zod";

export const HypothesisSchema = z.object({
  id: z.string(),
  rank: z.number(),
  statement: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  status: z.enum(["pending", "confirmed", "rejected", "inconclusive"]).default("pending"),
});

export const ReviewCommentSchema = z.object({
  id: z.string(),
  text: z.string(),
  addressed: z.boolean().default(false),
});

export const RunSummarySchema = z.object({
  bugSummary: z.string(),
  rootCause: z.string(),
  fixExplanation: z.string(),
  risks: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
});

export const TraceKindSchema = z.enum([
  "message",
  "tool",
  "todo",
  "task",
  "plan",
  "phase",
]);

export const TraceEntrySchema = z.object({
  ts: z.number(),
  phase: z.string(),
  kind: TraceKindSchema,
  text: z.string(),
});

export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  resumed: z.boolean(),
  debugResumeCommand: z.string(),
  agentResumeCommand: z.string(),
});

export const FinalReportSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  repoPath: z.string(),
  verifyMode: z.enum(["cli", "browser"]),
  url: z.string().optional(),
  bugDescription: z.string(),
  status: z.enum(["fixed", "partial", "abandoned"]),
  model: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  elapsedMs: z.number(),
  cycles: z.number(),
  hypotheses: z.array(HypothesisSchema),
  instrumentation: z.object({
    filesTouched: z.array(z.string()),
    sentinelCountBefore: z.number(),
    sentinelCountAfter: z.number(),
  }),
  reproduction: z.object({
    mode: z.enum(["cli", "browser"]),
    url: z.string().optional(),
    steps: z.array(z.string()),
    logEntries: z.array(z.unknown()),
  }),
  fix: z.object({
    diffStat: z.string().optional(),
    rootCause: z.string(),
    explanation: z.string(),
  }),
  review: z.object({
    comments: z.array(ReviewCommentSchema),
  }),
  summary: RunSummarySchema,
  session: SessionInfoSchema,
  trace: z.array(TraceEntrySchema).optional(),
  transcript: z.array(z.string()).optional(),
});

export type TraceKind = z.infer<typeof TraceKindSchema>;
export type TraceEntry = z.infer<typeof TraceEntrySchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type FinalReport = z.infer<typeof FinalReportSchema>;

export type Phase =
  | "hypothesize"
  | "instrument"
  | "reproduce"
  | "analyze"
  | "apply_fix"
  | "verify"
  | "mark_fixed"
  | "review"
  | "apply_review"
  | "re_verify"
  | "summarize"
  | "done";

export type VerifyMode = "cli" | "browser";

export interface RunLedger {
  runId: string;
  sessionId: string;
  sessionResumed: boolean;
  repoPath: string;
  verifyMode: VerifyMode;
  url?: string;
  bugDescription: string;
  model: string;
  reviewer: string;
  startedAt: number;
  phase: Phase;
  cycles: number;
  hypotheses: Hypothesis[];
  todos: Array<{ id: string; content: string; status: string }>;
  filesTouched: string[];
  sentinelCountBefore: number;
  sentinelCountAfter: number;
  reproductionSteps: string[];
  logEntries: unknown[];
  reviewComments: ReviewComment[];
  trace: TraceEntry[];
  transcript: string[];
  streamBuffer: string;
  confirmedHypothesisId?: string;
  fixProposed?: string;
  summary?: RunSummary;
  status: "running" | "fixed" | "partial" | "abandoned";
}
