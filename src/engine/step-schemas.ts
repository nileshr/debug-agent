import { z } from "zod";
import { HypothesisSchema, RunSummarySchema } from "../debug/types.js";

/**
 * Exit contracts for built-in steps. Schemas are deliberately lenient
 * (fields optional, unknown keys allowed) to match the historical tolerant
 * parsing of fenced-JSON agent replies.
 */

export const HypothesizeResultSchema = z
  .object({ hypotheses: z.array(HypothesisSchema).optional() })
  .passthrough();

export const InstrumentResultSchema = z
  .object({ filesTouched: z.array(z.string()).optional() })
  .passthrough();

export const ReproduceResultSchema = z
  .object({
    steps: z.array(z.string()).optional(),
    logCaptured: z.boolean().optional(),
  })
  .passthrough();

export const AnalyzeResultSchema = z
  .object({
    confirmedHypothesis: z.string().optional(),
    fixProposal: z.string().optional(),
  })
  .passthrough();

export const VerifyResultSchema = z
  .object({
    verified: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const MarkFixedResultSchema = z
  .object({ cleaned: z.boolean().optional() })
  .passthrough();

export const ReviewResultSchema = z
  .object({
    comments: z
      .array(
        z.object({
          id: z.string(),
          text: z.string(),
          addressed: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export const ApplyReviewResultSchema = z
  .object({ addressed: z.array(z.string()).optional() })
  .passthrough();

/** Summarize must match the strict run-summary contract to be recorded. */
export const SummarizeResultSchema = RunSummarySchema;

export type HypothesizeResult = z.infer<typeof HypothesizeResultSchema>;
export type InstrumentResult = z.infer<typeof InstrumentResultSchema>;
export type ReproduceResult = z.infer<typeof ReproduceResultSchema>;
export type AnalyzeResult = z.infer<typeof AnalyzeResultSchema>;
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
export type MarkFixedResult = z.infer<typeof MarkFixedResultSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ApplyReviewResult = z.infer<typeof ApplyReviewResultSchema>;
export type SummarizeResult = z.infer<typeof SummarizeResultSchema>;
