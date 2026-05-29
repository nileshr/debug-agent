import type { Phase } from "./types.js";

/** Phases executed by the debug loop (excludes terminal `done`). */
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

export function isDebugPhase(value: string): value is Phase {
  return (DEBUG_PHASES as readonly string[]).includes(value);
}
