// tests/rollover-policy.test.ts
// v0.4 — multi-policy rollover evaluation (pure functions, deterministic).
import { describe, it, expect } from 'bun:test';
import {
  evaluateRollover,
  resolvePolicy,
  verificationBudgetExceeded,
} from '../src/autonomous/rollover-policy';
import type { RolloverPolicy } from '../src/autonomous/types';

// helper: build an input with a fixed "now" so time-based tests are deterministic
function input(opts: {
  contextRatio?: number;
  turns?: number;
  startedAt?: string;
  now?: string;
}) {
  return {
    contextRatio: opts.contextRatio ?? 0,
    turnsInSession: opts.turns ?? 0,
    sessionStartedAt: opts.startedAt ?? '2025-01-01T00:00:00.000Z',
    now: opts.now ?? '2025-01-01T00:00:00.000Z',
  };
}

describe('resolvePolicy', () => {
  it('builds a policy from the legacy threshold when no policy is supplied', () => {
    const p = resolvePolicy(undefined, 0.75);
    expect(p.contextPercent).toBe(0.75);
    expect(p.maxTurnsPerSession).toBeUndefined();
    expect(p.maxMinutesPerSession).toBeUndefined();
  });

  it('uses the policy as-is when supplied', () => {
    const p = resolvePolicy({ contextPercent: 0.8, maxTurnsPerSession: 5 }, 0.75);
    expect(p.contextPercent).toBe(0.8);
    expect(p.maxTurnsPerSession).toBe(5);
  });

  it('falls back to legacy threshold when policy omits contextPercent', () => {
    const p = resolvePolicy({ maxTurnsPerSession: 3 }, 0.6);
    expect(p.contextPercent).toBe(0.6);
    expect(p.maxTurnsPerSession).toBe(3);
  });
});

describe('evaluateRollover — context policy', () => {
  const policy: RolloverPolicy = { contextPercent: 0.75 };

  it('trips at exactly the threshold (>= semantics)', () => {
    const r = evaluateRollover(policy, input({ contextRatio: 0.75 }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('context');
  });

  it('trips above the threshold', () => {
    const r = evaluateRollover(policy, input({ contextRatio: 0.9 }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('context');
  });

  it('does NOT trip below the threshold', () => {
    const r = evaluateRollover(policy, input({ contextRatio: 0.74 }));
    expect(r.shouldRollOver).toBe(false);
  });

  it('does not trip when contextPercent is 0 (disabled)', () => {
    const r = evaluateRollover({ contextPercent: 0 }, input({ contextRatio: 0.99 }));
    expect(r.shouldRollOver).toBe(false);
  });
});

describe('evaluateRollover — turns policy', () => {
  const policy: RolloverPolicy = { maxTurnsPerSession: 3 };

  it('trips when turns >= max', () => {
    const r = evaluateRollover(policy, input({ turns: 3 }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('turns');
  });

  it('trips above max', () => {
    const r = evaluateRollover(policy, input({ turns: 5 }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('turns');
  });

  it('does NOT trip below max', () => {
    const r = evaluateRollover(policy, input({ turns: 2 }));
    expect(r.shouldRollOver).toBe(false);
  });

  it('does not trip when maxTurnsPerSession is 0 (disabled)', () => {
    const r = evaluateRollover({ maxTurnsPerSession: 0 }, input({ turns: 100 }));
    expect(r.shouldRollOver).toBe(false);
  });
});

describe('evaluateRollover — time policy', () => {
  const policy: RolloverPolicy = { maxMinutesPerSession: 30 };

  it('trips when elapsed >= max', () => {
    // started 60 minutes ago
    const r = evaluateRollover(policy, input({
      startedAt: '2025-01-01T00:00:00.000Z',
      now: '2025-01-01T01:00:00.000Z', // 60 min later
    }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('time');
  });

  it('trips at exactly max minutes', () => {
    const r = evaluateRollover(policy, input({
      startedAt: '2025-01-01T00:00:00.000Z',
      now: '2025-01-01T00:30:00.000Z', // exactly 30 min later
    }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('time');
  });

  it('does NOT trip before max minutes', () => {
    const r = evaluateRollover(policy, input({
      startedAt: '2025-01-01T00:00:00.000Z',
      now: '2025-01-01T00:29:00.000Z', // 29 min later
    }));
    expect(r.shouldRollOver).toBe(false);
  });

  it('does not trip when maxMinutesPerSession is 0 (disabled)', () => {
    const r = evaluateRollover({ maxMinutesPerSession: 0 }, input({
      startedAt: '2025-01-01T00:00:00.000Z',
      now: '2025-01-02T00:00:00.000Z', // 24h later
    }));
    expect(r.shouldRollOver).toBe(false);
  });

  it('handles invalid timestamps gracefully', () => {
    const r = evaluateRollover(policy, input({
      startedAt: 'not-a-date',
      now: '2025-01-01T00:30:00.000Z',
    }));
    expect(r.shouldRollOver).toBe(false);
  });
});

describe('evaluateRollover — combined policies (OR semantics)', () => {
  const policy: RolloverPolicy = {
    contextPercent: 0.75,
    maxTurnsPerSession: 5,
    maxMinutesPerSession: 30,
  };

  it('context takes priority (trips first)', () => {
    const r = evaluateRollover(policy, input({
      contextRatio: 0.8,
      turns: 10,
      startedAt: '2025-01-01T00:00:00.000Z',
      now: '2025-01-01T02:00:00.000Z', // 120 min
    }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('context'); // highest priority
  });

  it('turns trips when context does not', () => {
    const r = evaluateRollover(policy, input({
      contextRatio: 0.5,
      turns: 6,
      startedAt: '2025-01-01T00:00:00.000Z',
      now: '2025-01-01T00:10:00.000Z', // 10 min
    }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('turns');
  });

  it('time trips when context + turns do not', () => {
    const r = evaluateRollover(policy, input({
      contextRatio: 0.5,
      turns: 2,
      startedAt: '2025-01-01T00:00:00.000Z',
      now: '2025-01-01T01:00:00.000Z', // 60 min
    }));
    expect(r.shouldRollOver).toBe(true);
    expect(r.reason).toBe('time');
  });

  it('nothing trips when all policies are below threshold', () => {
    const r = evaluateRollover(policy, input({
      contextRatio: 0.5,
      turns: 2,
      startedAt: '2025-01-01T00:00:00.000Z',
      now: '2025-01-01T00:10:00.000Z', // 10 min
    }));
    expect(r.shouldRollOver).toBe(false);
  });
});

describe('verificationBudgetExceeded', () => {
  it('false when maxVerificationAttempts is undefined (unlimited)', () => {
    expect(verificationBudgetExceeded(5, undefined)).toBe(false);
  });

  it('false when maxVerificationAttempts is 0 (unlimited)', () => {
    expect(verificationBudgetExceeded(5, 0)).toBe(false);
  });

  it('false when below the budget', () => {
    expect(verificationBudgetExceeded(2, 5)).toBe(false);
    expect(verificationBudgetExceeded(4, 5)).toBe(false);
  });

  it('true when at or above the budget', () => {
    expect(verificationBudgetExceeded(5, 5)).toBe(true);
    expect(verificationBudgetExceeded(10, 5)).toBe(true);
  });
});
