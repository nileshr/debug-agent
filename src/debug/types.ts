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

export const PhaseTimelineEntrySchema = z.object({
  phase: z.string(),
  status: z.enum(["pending", "running", "completed", "skipped"]),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
});

export const StepTimelineEntrySchema = z.object({
  seq: z.number(),
  stepId: z.string(),
  attempt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  dataSource: z.enum(["structured", "json_extraction", "none"]).optional(),
  ok: z.boolean().optional(),
  inserted: z.boolean().optional(),
});

export const DecisionTimelineEntrySchema = z.object({
  seq: z.number(),
  ts: z.number(),
  afterStep: z.string(),
  decidedBy: z.enum(["static", "heuristic", "llm", "user", "guardrail_override"]),
  action: z.enum(["advance", "retry", "insert", "skip_to", "ask_user", "abort", "done"]),
  nextStepId: z.string().optional(),
  rationale: z.string().optional(),
  overridden: z
    .object({
      action: z.string(),
      nextStepId: z.string().optional(),
      reason: z.string(),
    })
    .optional(),
  modelId: z.string().optional(),
  latencyMs: z.number().optional(),
});

export const FinalReportSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  repoPath: z.string(),
  verifyMode: z.enum(["cli", "browser"]),
  url: z.string().optional(),
  bugDescription: z.string(),
  status: z.enum(["fixed", "partial", "abandoned"]),
  runLifecycleStatus: z
    .enum(["running", "interrupted", "completed", "failed"])
    .optional(),
  currentPhase: z.string().optional(),
  model: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  elapsedMs: z.number(),
  /** Verify/fix loop count (verify phase). */
  cycles: z.number(),
  /** Review loop count (re_verify attempts). */
  reviewCycles: z.number(),
  confirmedHypothesisId: z.string().optional(),
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
  phaseTimeline: z.array(PhaseTimelineEntrySchema).optional(),
  stepTimeline: z.array(StepTimelineEntrySchema).optional(),
  decisionTimeline: z.array(DecisionTimelineEntrySchema).optional(),
});

export type TraceKind = z.infer<typeof TraceKindSchema>;
export type TraceEntry = z.infer<typeof TraceEntrySchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type PhaseTimelineEntry = z.infer<typeof PhaseTimelineEntrySchema>;
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

/** One executed step (dynamic step list; replaces the fixed phase notion). */
export interface StepExecutionRecord {
  seq: number;
  stepId: string;
  attempt: number;
  startedAt: number;
  endedAt?: number;
  dataSource?: "structured" | "json_extraction" | "none";
  ok?: boolean;
  inserted?: boolean;
}

export type DecisionAction =
  | "advance"
  | "retry"
  | "insert"
  | "skip_to"
  | "ask_user"
  | "abort"
  | "done";

export type DecisionMaker =
  | "static"
  | "heuristic"
  | "llm"
  | "user"
  | "guardrail_override";

/** Auditable record of one loop-control decision. */
export interface DecisionRecord {
  seq: number;
  ts: number;
  afterStep: string;
  decidedBy: DecisionMaker;
  action: DecisionAction;
  nextStepId?: string;
  rationale?: string;
  /** Set when the engine vetoed an orchestrator decision. */
  overridden?: { action: DecisionAction; nextStepId?: string; reason: string };
  modelId?: string;
  latencyMs?: number;
}

export interface RunLedger {
  runId: string;
  sessionId: string;
  sessionResumed: boolean;
  repoPath: string;
  verifyMode: VerifyMode;
  url?: string;
  bugDescription: string;
  /** Fixer model (most phases). */
  model: string;
  plannerModel: string;
  /** Reviewer model (review phase). */
  reviewer: string;
  browserMcp?: "chrome-devtools" | "playwright";
  startedAt: number;
  phase: Phase;
  cycles: number;
  /** Completed re_verify attempts (review loop). */
  reviewCycles?: number;
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
  /** v2 additions (absent on ledgers written by older builds). */
  ledgerVersion?: number;
  runtime?: "acp" | "flue";
  agentPreset?: string;
  autonomy?: "static" | "guided" | "autonomous";
  stepHistory?: StepExecutionRecord[];
  decisions?: DecisionRecord[];
}
