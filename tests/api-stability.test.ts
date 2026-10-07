// tests/api-stability.test.ts
// v1.0 — verifies the frozen public API surface exists and has the right shape.
//
// This test is a CONTRACT: if it fails, a frozen export was removed or renamed,
// which is a breaking change requiring a major version bump.
import { describe, it, expect } from 'bun:test';
import * as api from '../src/autonomous';

describe('API stability — frozen exports exist', () => {
  it('exports all core types (as values — TS types are erased at runtime)', () => {
    // Types are erased at runtime, but we can verify the module doesn't throw
    // on import and has the expected shape.
    expect(api).toBeDefined();
    expect(typeof api).toBe('object');
  });

  it('exports the AutonomousSessionController class', () => {
    expect(api.AutonomousSessionController).toBeDefined();
    expect(typeof api.AutonomousSessionController).toBe('function');
    // Verify it's a constructor
    expect(() => {
      new api.AutonomousSessionController({
        store: {} as any,
        logger: {} as any,
        generateHandoffResponse: async () => null,
        sendPrompt: async () => {},
      });
    }).not.toThrow();
  });

  it('exports the controller methods', () => {
    const c = new api.AutonomousSessionController({
      store: {} as any,
      logger: {} as any,
      generateHandoffResponse: async () => null,
      sendPrompt: async () => {},
    });
    expect(typeof c.startRun).toBe('function');
    expect(typeof c.onContextUsage).toBe('function');
    expect(typeof c.onTurnFinished).toBe('function');
    expect(typeof c.stopRun).toBe('function');
    expect(typeof c.resumeRun).toBe('function');
    expect(typeof c.clearAll).toBe('function');
    expect(typeof c.getState).toBe('function');
  });

  it('exports the recover function', () => {
    expect(typeof api.recover).toBe('function');
  });

  it('exports handoff functions', () => {
    expect(typeof api.buildHandoffPrompt).toBe('function');
    expect(typeof api.validateHandoff).toBe('function');
    expect(typeof api.isValidHandoff).toBe('function');
    expect(typeof api.parseHandoffResponse).toBe('function');
    expect(typeof api.serializeHandoff).toBe('function');
    expect(typeof api.stampObjective).toBe('function');
  });

  it('exports handoff-schema functions (v0.3)', () => {
    expect(typeof api.defaultHandoffSchema).toBe('function');
    expect(typeof api.createHandoffSchema).toBe('function');
    expect(typeof api.buildHandoffPromptFromSchema).toBe('function');
    expect(typeof api.validateHandoffAgainstSchema).toBe('function');
    expect(typeof api.serializeHandoffWithSchema).toBe('function');
    expect(typeof api.parseHandoffResponseWithSchema).toBe('function');
    expect(typeof api.coerceToHandoff).toBe('function');
  });

  it('exports rollover-policy functions (v0.4)', () => {
    expect(typeof api.evaluateRollover).toBe('function');
    expect(typeof api.resolvePolicy).toBe('function');
    expect(typeof api.verificationBudgetExceeded).toBe('function');
  });

  it('exports context-monitor functions', () => {
    expect(typeof api.contextRatio).toBe('function');
    expect(typeof api.shouldMarkRolloverPending).toBe('function');
  });

  it('exports completion-detector functions', () => {
    expect(typeof api.detectWorkerStatus).toBe('function');
    expect(typeof api.detectVerificationStatus).toBe('function');
  });

  it('exports session-manager functions', () => {
    expect(typeof api.createFreshSession).toBe('function');
    expect(typeof api.formatSessionName).toBe('function');
  });

  it('exports webhook functions (v0.6+)', () => {
    expect(typeof api.createWebhookNotifier).toBe('function');
    expect(typeof api.signPayload).toBe('function');
    expect(typeof api.verifySignature).toBe('function');
    expect(typeof api.normalizeWebhooks).toBe('function');
    expect(typeof api.getDeliveryLog).toBe('function');
    expect(typeof api.clearDeliveryLog).toBe('function');
    expect(typeof api.replayFailedDeliveries).toBe('function');
    expect(typeof api.getReplayableDeliveries).toBe('function');
    expect(typeof api.buildRunSnapshot).toBe('function');
  });

  it('exports all frozen constants', () => {
    expect(api.AUTONOMOUS_SCHEMA_VERSION).toBeDefined();
    expect(typeof api.AUTONOMOUS_SCHEMA_VERSION).toBe('number');

    expect(api.DEFAULT_ROLLOVER_THRESHOLD).toBeDefined();
    expect(typeof api.DEFAULT_ROLLOVER_THRESHOLD).toBe('number');

    expect(api.DEFAULT_CONTEXT_LIMIT).toBeDefined();
    expect(typeof api.DEFAULT_CONTEXT_LIMIT).toBe('number');

    expect(api.MAX_LOG_ROWS).toBeDefined();
    expect(typeof api.MAX_LOG_ROWS).toBe('number');

    expect(api.MARKER_WORKER_COMPLETE).toBeDefined();
    expect(typeof api.MARKER_WORKER_COMPLETE).toBe('string');
    expect(api.MARKER_WORKER_COMPLETE).toBe('AUTONOMOUS_STATUS: COMPLETE');

    expect(api.MARKER_WORKER_CONTINUE).toBe('AUTONOMOUS_STATUS: CONTINUE');
    expect(api.MARKER_VERIFY_PASS).toBe('AUTONOMOUS_VERIFICATION: PASS');
    expect(api.MARKER_VERIFY_FAIL).toBe('AUTONOMOUS_VERIFICATION: FAIL');

    expect(api.NAV_EVENT_SWITCH_SESSION).toBeDefined();
    expect(api.IPC).toBeDefined();
    expect(api.DEFAULT_SETTINGS).toBeDefined();
  });

  it('defaultHandoffSchema returns 9 fields', () => {
    const schema = api.defaultHandoffSchema();
    expect(Array.isArray(schema)).toBe(true);
    expect(schema.length).toBe(9);
    const names = schema.map((f) => f.name);
    expect(names).toContain('currentState');
    expect(names).toContain('completedWork');
    expect(names).toContain('remainingWork');
    expect(names).toContain('filesChanged');
    expect(names).toContain('tests');
    expect(names).toContain('failures');
    expect(names).toContain('decisions');
    expect(names).toContain('constraints');
    expect(names).toContain('nextAction');
  });

  it('marker strings are frozen (exact format)', () => {
    // These MUST NOT change — receivers parse them by exact-line matching.
    expect(api.MARKER_WORKER_COMPLETE).toBe('AUTONOMOUS_STATUS: COMPLETE');
    expect(api.MARKER_WORKER_CONTINUE).toBe('AUTONOMOUS_STATUS: CONTINUE');
    expect(api.MARKER_VERIFY_PASS).toBe('AUTONOMOUS_VERIFICATION: PASS');
    expect(api.MARKER_VERIFY_FAIL).toBe('AUTONOMOUS_VERIFICATION: FAIL');
  });

  it('IPC channel names are frozen', () => {
    expect(api.IPC.GET_STATE).toBe('autonomous:get-state');
    expect(api.IPC.SET_STATE).toBe('autonomous:set-state');
    expect(api.IPC.CLEAR_STATE).toBe('autonomous:clear-state');
    expect(api.IPC.GET_SETTINGS).toBe('autonomous:get-settings');
    expect(api.IPC.SET_SETTINGS).toBe('autonomous:set-settings');
  });

  it('schema version is 1', () => {
    expect(api.AUTONOMOUS_SCHEMA_VERSION).toBe(1);
  });

  it('DEFAULT_SETTINGS has the right shape', () => {
    expect(api.DEFAULT_SETTINGS.enabled).toBe(false);
    expect(api.DEFAULT_SETTINGS.rolloverThreshold).toBe(0.75);
  });
});

describe('API stability — function signatures', () => {
  it('contextRatio(used, limit) returns a number 0..1', () => {
    const r = api.contextRatio(150, 200);
    expect(typeof r).toBe('number');
    expect(r).toBe(0.75);
    expect(api.contextRatio(0, 200)).toBe(0);
    expect(api.contextRatio(200, 200)).toBe(1);
  });

  it('detectWorkerStatus(text) returns complete|continue|unknown', () => {
    expect(api.detectWorkerStatus('AUTONOMOUS_STATUS: COMPLETE')).toBe('complete');
    expect(api.detectWorkerStatus('AUTONOMOUS_STATUS: CONTINUE')).toBe('continue');
    expect(api.detectWorkerStatus('nothing')).toBe('unknown');
  });

  it('detectVerificationStatus(text) returns pass|fail|unknown', () => {
    expect(api.detectVerificationStatus('AUTONOMOUS_VERIFICATION: PASS')).toBe('pass');
    expect(api.detectVerificationStatus('AUTONOMOUS_VERIFICATION: FAIL')).toBe('fail');
    expect(api.detectVerificationStatus('nothing')).toBe('unknown');
  });

  it('formatSessionName(role, gen) returns the right format', () => {
    expect(api.formatSessionName('worker', 1)).toBe('[Auto] Worker 01');
    expect(api.formatSessionName('worker', 12)).toBe('[Auto] Worker 12');
    expect(api.formatSessionName('verification', 3)).toBe('[Auto] Verification 03');
  });

  it('signPayload + verifySignature round-trip', () => {
    const sig = api.signPayload('secret', '{"event":"test"}');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(api.verifySignature('secret', '{"event":"test"}', sig)).toBe(true);
    expect(api.verifySignature('wrong', '{"event":"test"}', sig)).toBe(false);
  });

  it('resolvePolicy falls back to legacy threshold', () => {
    const p = api.resolvePolicy(undefined, 0.75);
    expect(p.contextPercent).toBe(0.75);
  });

  it('verificationBudgetExceeded respects 0/undefined = unlimited', () => {
    expect(api.verificationBudgetExceeded(100, undefined)).toBe(false);
    expect(api.verificationBudgetExceeded(100, 0)).toBe(false);
    expect(api.verificationBudgetExceeded(5, 5)).toBe(true);
  });
});
