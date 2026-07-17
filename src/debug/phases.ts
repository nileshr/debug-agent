import type { Phase } from "./types.js";

/**
 * Nominal built-in step order. Only used to seed the legacy `run_phases`
 * table (kept for pre-v2 builds sharing the state DB); the engine's source of
 * truth is the StepCatalog in src/engine/catalog.ts.
 */
export const DEBUG_PHASES: readonly Phase[] = [
  "hypothesize",
  "instrument",
  "reproduce",
  "analyze",
  "apply_fix",
  "verify",
  "mark_fixed",
  "review",
  "apply_review",
  "re_verify",
  "summarize",
] as const;
