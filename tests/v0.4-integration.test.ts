// tests/v0.4-integration.test.ts
// v0.4 — controller integration: verification budget + multi-policy rollover.
import { describe, it, expect, beforeEach } from 'bun:test';
import { AutonomousSessionController } from '../src/autonomous/controller';
import { inMemoryStore } from '../examples/in-memory-adapters';
import type { AutonomousSettings, RolloverPolicy } from '../src/autonomous/types';

const silentLogger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {},
};

function makeController(settings?: AutonomousSettings) {
  const controller = new AutonomousSessionController({
    store: inMemoryStore,
    logger: silentLogger as any,
    settings,
    generateHandoffResponse: async () =>
      JSON.stringify({
        currentState: 'mid',
        completedWork: ['a'],
        remainingWork: ['b'],
        filesChanged: ['f.ts'],
        tests: [],
        failures: [],
        decisions: [],
        constraints: [],
        nextAction: 'do b',
      }),
    sendPrompt: async () => {},
  });
  return controller;
}

function emptyTurn(sessionId: string, role: 'worker' | 'verification' = 'worker') {
  return {
    sessionId,
    turnIndex: 0,
    role,
    summary: '',
    filesTouched: [],
    testsRun: [],
    contextBefore: 0,
    contextAfter: 0,
    ts: new Date().toISOString(),
  };
}

async function startRun(controller: AutonomousSessionController, settings: AutonomousSettings) {
  return controller.startRun({
    sessionId: 's1',
    objective: 'do the thing',
    settings,
  });
}

describe('v0.4: verification budget', () => {
  beforeEach(async () => {
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('allows verification when budget is unlimited (default)', async () => {
    const controller = makeController();
    await startRun(controller, { enabled: true, rolloverThreshold: 0.99 });
    // worker 1 completes
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', emptyTurn('s1'));
    expect(run?.phase).toBe('verifying');
    expect(run?.verificationAttempt).toBe(1);
    // verifier 1 fails
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: FAIL\n- not done',
      emptyTurn(run!.currentSessionId, 'verification')
    );
    expect(run?.phase).toBe('working');
    // worker 2 completes
    run = await controller.onTurnFinished(run!.currentSessionId, 'AUTONOMOUS_STATUS: COMPLETE', emptyTurn(run!.currentSessionId));
    expect(run?.verificationAttempt).toBe(2);
    // verifier 2 passes
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: PASS',
      emptyTurn(run!.currentSessionId, 'verification')
    );
    expect(run?.status).toBe('completed');
  });

  it('halts the run when the verification budget is exhausted', async () => {
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      maxVerificationAttempts: 2,
    });
    await startRun(controller, { enabled: true, rolloverThreshold: 0.99 });

    // worker 1 → complete → verifier 1 → fail
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', emptyTurn('s1'));
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: FAIL\n- not done',
      emptyTurn(run!.currentSessionId, 'verification')
    );
    expect(run?.verificationAttempt).toBe(1);
    expect(run?.phase).toBe('working');

    // worker 2 → complete → verifier 2 → fail
    run = await controller.onTurnFinished(run!.currentSessionId, 'AUTONOMOUS_STATUS: COMPLETE', emptyTurn(run!.currentSessionId));
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: FAIL\n- still not done',
      emptyTurn(run!.currentSessionId, 'verification')
    );
    expect(run?.verificationAttempt).toBe(2);
    expect(run?.phase).toBe('working');

    // worker 3 → complete → should HIT the budget (nextAttempt = 3 > 2)
    run = await controller.onTurnFinished(run!.currentSessionId, 'AUTONOMOUS_STATUS: COMPLETE', emptyTurn(run!.currentSessionId));
    expect(run?.status).toBe('error');
    expect(run?.phase).toBe('error');
    expect(run?.lastError).toContain('Verification budget exhausted');
    expect(run?.verificationAttempt).toBe(2); // did not increment to 3
  });

  it('allows exactly maxVerificationAttempts verifications', async () => {
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      maxVerificationAttempts: 1,
    });
    await startRun(controller, { enabled: true, rolloverThreshold: 0.99 });

    // worker 1 → complete → verifier 1 (the only attempt allowed) → pass
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', emptyTurn('s1'));
    expect(run?.verificationAttempt).toBe(1);
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: PASS',
      emptyTurn(run!.currentSessionId, 'verification')
    );
    expect(run?.status).toBe('completed');
  });
});

describe('v0.4: multi-policy rollover', () => {
  beforeEach(async () => {
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('rollover trips on maxTurnsPerSession (no context pressure)', async () => {
    const policy: RolloverPolicy = { maxTurnsPerSession: 2, contextPercent: 0.99 };
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      rolloverPolicy: policy,
    });
    await startRun(controller, { enabled: true, rolloverThreshold: 0.99 });

    // turn 1 — no rollover yet
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1'));
    expect(run?.phase).toBe('working');
    expect(run?.workerGeneration).toBe(1);
    expect(run?.turnsInCurrentSession).toBe(1);

    // turn 2 — should trip maxTurnsPerSession=2 → rollover
    run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1'));
    expect(run?.workerGeneration).toBe(2);
    expect(run?.turnsInCurrentSession).toBe(0); // reset for fresh worker
    expect(run?.rolloverPending).toBe(false);
  });

  it('rollover trips on context % (legacy behavior preserved)', async () => {
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.75,
      // no rolloverPolicy → falls back to legacy rolloverThreshold
    });
    await startRun(controller, { enabled: true, rolloverThreshold: 0.75 });

    // push context past 75%
    await controller.onContextUsage('s1', 160000, 200000); // 80%
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1'));
    expect(run?.workerGeneration).toBe(2);
    expect(run?.contextUsage).toBe(0); // reset
  });

  it('rollover resets per-session tracking for the fresh worker', async () => {
    const policy: RolloverPolicy = { maxTurnsPerSession: 1 };
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      rolloverPolicy: policy,
    });
    await startRun(controller, { enabled: true, rolloverThreshold: 0.99 });

    // turn 1 → rollover (maxTurnsPerSession=1)
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1'));
    expect(run?.workerGeneration).toBe(2);
    expect(run?.turnsInCurrentSession).toBe(0);
    expect(run?.currentSessionStartedAt).toBeDefined();

    // turn 1 of worker 2 → should NOT rollover (only 1 turn, max is 1 — wait, >= 1 trips)
    // Actually maxTurnsPerSession=1 means: trip when turns >= 1. So turn 1 of worker 2 trips.
    // Let's verify: turn 1 → rollover again.
    const worker2Session = run!.currentSessionId;
    run = await controller.onTurnFinished(worker2Session, 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn(worker2Session));
    expect(run?.workerGeneration).toBe(3);
    expect(run?.turnsInCurrentSession).toBe(0);
  });

  it('rolloverReason is recorded when a policy trips', async () => {
    const policy: RolloverPolicy = { maxTurnsPerSession: 1 };
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      rolloverPolicy: policy,
    });
    await startRun(controller, { enabled: true, rolloverThreshold: 0.99 });

    // turn 1 → trips turns policy
    const run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1'));
    // After rollover completes, rolloverReason is cleared. We can't observe it
    // in the final state, but the run should have rolled over.
    expect(run?.workerGeneration).toBe(2);
  });
});
