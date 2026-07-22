import type { StepDefinition } from "./catalog.js";
import { DONE, type StepPolicy, type TransitionContext } from "./policy.js";
import type { OrchestratorDecision } from "./orchestrator.js";

export interface GuardrailInput {
  step: StepDefinition;
  policy: StepPolicy;
  ctx: TransitionContext;
  attempt: number;
  insertedCount: number;
  catalogIds: Set<string>;
}

export interface GuardrailResult {
  decision: OrchestratorDecision;
  /** Present when the proposed decision was vetoed and substituted. */
  overridden?: { decision: OrchestratorDecision; reason: string };
}

function fallback(
  input: GuardrailInput,
  proposed: OrchestratorDecision,
  reason: string,
): GuardrailResult {
  const next = input.policy.defaultNext[input.step.id](input.ctx);
  const decision: OrchestratorDecision =
    next === DONE
      ? { action: "done", rationale: `Guardrail override: ${reason}` }
      : next === input.step.id
        ? { action: "retry", rationale: `Guardrail override: ${reason}` }
        : {
            action: "advance",
            nextStepId: next,
            rationale: `Guardrail override: ${reason}`,
          };
  return { decision, overridden: { decision: proposed, reason } };
}

/**
 * Engine-enforced validation of orchestrator decisions. The LLM (or a buggy
 * heuristic) can never move the loop outside the policy's menus or budgets —
 * illegal decisions are replaced by the static default and both are recorded.
 */
export function applyGuardrails(
  input: GuardrailInput,
  proposed: OrchestratorDecision,
): GuardrailResult {
  const { step, policy, attempt, insertedCount, catalogIds } = input;
  const budgets = policy.budgets;

  switch (proposed.action) {
    case "advance":
    case "skip_to": {
      const allowed = policy.allowedNext[step.id] ?? [];
      if (!proposed.nextStepId || !allowed.includes(proposed.nextStepId)) {
        return fallback(
          input,
          proposed,
          `"${proposed.nextStepId ?? "(none)"}" is not a legal transition from ${step.id} (allowed: ${allowed.join(", ")})`,
        );
      }
      if (proposed.nextStepId !== DONE && !catalogIds.has(proposed.nextStepId)) {
        return fallback(input, proposed, `unknown step "${proposed.nextStepId}"`);
      }
      return { decision: proposed };
    }
    case "retry": {
      const maxAttempts = Math.max(
        budgets.maxAttemptsPerStep,
        step.id === "mark_fixed" ? 3 : 0,
      );
      if (attempt >= maxAttempts) {
        return fallback(
          input,
          proposed,
          `retry budget exhausted for ${step.id} (attempt ${attempt}/${maxAttempts})`,
        );
      }
      return { decision: proposed };
    }
    case "insert": {
      if (!policy.insertable.includes(proposed.stepId)) {
        return fallback(
          input,
          proposed,
          `step "${proposed.stepId}" is not insertable (allowed: ${policy.insertable.join(", ")})`,
        );
      }
      if (!catalogIds.has(proposed.stepId)) {
        return fallback(input, proposed, `unknown step "${proposed.stepId}"`);
      }
      if (insertedCount >= budgets.maxInsertedSteps) {
        return fallback(
          input,
          proposed,
          `insert budget exhausted (${insertedCount}/${budgets.maxInsertedSteps})`,
        );
      }
      return { decision: proposed };
    }
    case "ask_user": {
      if (proposed.questions.length === 0) {
        return fallback(input, proposed, "ask_user without questions");
      }
      return { decision: proposed };
    }
    case "abort":
    case "done":
      return { decision: proposed };
  }
}
