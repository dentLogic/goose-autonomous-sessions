// src/autonomous/rollover-policy.ts
//
// v0.4 — multi-policy rollover evaluation.
//
// v0.1–v0.3 supported only context-percentage rollover. v0.4 adds optional
// turn-count and time-based policies. All enabled policies are combined with
// OR semantics — any one tripping marks rollover pending.
//
// Pure functions, no side effects, fully testable in isolation.
import type { RolloverPolicy, RolloverReason } from './types';

export interface RolloverEvaluationInput {
  /** 0..1 — current context usage ratio. */
  contextRatio: number;
  /** Completed worker turns in the current session. */
  turnsInSession: number;
  /** ISO timestamp when the current session became active. */
  sessionStartedAt: string;
  /** Current time (ISO). Passed in so tests can be deterministic. */
  now: string;
  /** v0.5: estimated token cost (cents) accumulated in the current session. */
  sessionCostCents?: number;
}

export interface RolloverEvaluation {
  shouldRollOver: boolean;
  reason?: RolloverReason;
  /** Human-readable description, for logging. */
  description: string;
}

/**
 * Resolve the effective policy. If `policy` is supplied, use it (falling back
 * to `legacyThreshold` for `contextPercent` when that field is absent). If
 * `policy` is absent, build one from the legacy `rolloverThreshold`.
 */
export function resolvePolicy(
  policy: RolloverPolicy | undefined,
  legacyThreshold: number
): RolloverPolicy {
  if (!policy) {
    return { contextPercent: legacyThreshold };
  }
  return {
    contextPercent: policy.contextPercent ?? legacyThreshold,
    maxTurnsPerSession: policy.maxTurnsPerSession,
    maxMinutesPerSession: policy.maxMinutesPerSession,
    maxCostCentsPerSession: policy.maxCostCentsPerSession,
  };
}

/**
 * Evaluate the rollover policy against the current session state.
 * Returns the FIRST tripped policy (priority: context > turns > time > cost).
 * If nothing tripped, returns { shouldRollOver: false }.
 */
export function evaluateRollover(
  policy: RolloverPolicy,
  input: RolloverEvaluationInput
): RolloverEvaluation {
  // 1. context
  if (
    typeof policy.contextPercent === 'number' &&
    policy.contextPercent > 0 &&
    input.contextRatio >= policy.contextPercent
  ) {
    return {
      shouldRollOver: true,
      reason: 'context',
      description: `context ${Math.round(input.contextRatio * 100)}% ≥ ${Math.round(policy.contextPercent * 100)}%`,
    };
  }

  // 2. turns
  if (
    typeof policy.maxTurnsPerSession === 'number' &&
    policy.maxTurnsPerSession > 0 &&
    input.turnsInSession >= policy.maxTurnsPerSession
  ) {
    return {
      shouldRollOver: true,
      reason: 'turns',
      description: `turns ${input.turnsInSession} ≥ ${policy.maxTurnsPerSession}`,
    };
  }

  // 3. time
  if (
    typeof policy.maxMinutesPerSession === 'number' &&
    policy.maxMinutesPerSession > 0 &&
    input.sessionStartedAt
  ) {
    const startedAt = Date.parse(input.sessionStartedAt);
    const nowMs = Date.parse(input.now);
    if (Number.isFinite(startedAt) && Number.isFinite(nowMs) && nowMs >= startedAt) {
      const elapsedMin = (nowMs - startedAt) / 60000;
      if (elapsedMin >= policy.maxMinutesPerSession) {
        return {
          shouldRollOver: true,
          reason: 'time',
          description: `elapsed ${elapsedMin.toFixed(1)}min ≥ ${policy.maxMinutesPerSession}min`,
        };
      }
    }
  }

  // 4. cost (v0.5)
  if (
    typeof policy.maxCostCentsPerSession === 'number' &&
    policy.maxCostCentsPerSession > 0 &&
    typeof input.sessionCostCents === 'number' &&
    input.sessionCostCents >= policy.maxCostCentsPerSession
  ) {
    return {
      shouldRollOver: true,
      reason: 'cost',
      description: `cost ${input.sessionCostCents}¢ ≥ ${policy.maxCostCentsPerSession}¢`,
    };
  }

  return { shouldRollOver: false, description: 'no policy tripped' };
}

/**
 * Whether the run has exceeded its verification budget.
 * Returns false if maxVerificationAttempts is unset/zero (unlimited).
 */
export function verificationBudgetExceeded(
  verificationAttempt: number,
  maxVerificationAttempts: number | undefined
): boolean {
  if (!maxVerificationAttempts || maxVerificationAttempts <= 0) return false;
  // verificationAttempt is the count of verifiers created so far.
  // If we've already hit the max and are about to create another, that's exceeded.
  return verificationAttempt >= maxVerificationAttempts;
}
