// tests/v0.5-integration.test.ts
// v0.5 — cost-based rollover + run resume.
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
  return new AutonomousSessionController({
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
}

function turnWithCost(sessionId: string, costCents: number, text = 'AUTONOMOUS_STATUS: CONTINUE') {
  return {
    sessionId,
    turnIndex: 0,
    role: 'worker' as const,
    summary: '',
    filesTouched: [],
    testsRun: [],
    contextBefore: 0,
    contextAfter: 0,
    ts: new Date().toISOString(),
    costCents,
  };
}

function turnNoCost(sessionId: string, role: 'worker' | 'verification' = 'worker', text = 'AUTONOMOUS_STATUS: CONTINUE') {
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

describe('v0.5: cost-based rollover', () => {
  beforeEach(async () => {
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('rolls over when session cost exceeds the budget', async () => {
    const policy: RolloverPolicy = {
      contextPercent: 0.99, // disable context
      maxCostCentsPerSession: 50, // 50¢ budget
    };
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      rolloverPolicy: policy,
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });

    // turn 1: 30¢ — under budget
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 30));
    expect(run?.phase).toBe('working');
    expect(run?.workerGeneration).toBe(1);
    expect(run?.sessionCostCents).toBe(30);
    expect(run?.totalCostCents).toBe(30);

    // turn 2: +25¢ = 55¢ — over budget (50¢) → rollover
    run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 25));
    expect(run?.workerGeneration).toBe(2);
    expect(run?.sessionCostCents).toBe(0); // reset for fresh worker
    expect(run?.totalCostCents).toBe(55); // total preserved
  });

  it('does NOT roll over when cost is below the budget', async () => {
    const policy: RolloverPolicy = { contextPercent: 0.99, maxCostCentsPerSession: 100 };
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      rolloverPolicy: policy,
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });

    const run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 40));
    expect(run?.phase).toBe('working');
    expect(run?.workerGeneration).toBe(1);
    expect(run?.sessionCostCents).toBe(40);
  });

  it('accumulates total cost across the entire run (never resets)', async () => {
    const policy: RolloverPolicy = { contextPercent: 0.99, maxCostCentsPerSession: 30 };
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      rolloverPolicy: policy,
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });

    // turn 1: 35¢ → rollover (35 >= 30)
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 35));
    expect(run?.workerGeneration).toBe(2);
    expect(run?.totalCostCents).toBe(35);

    // turn 1 of worker 2: 40¢ → rollover
    run = await controller.onTurnFinished(run!.currentSessionId, 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost(run!.currentSessionId, 40));
    expect(run?.workerGeneration).toBe(3);
    expect(run?.totalCostCents).toBe(75); // 35 + 40
    expect(run?.sessionCostCents).toBe(0); // reset
  });

  it('handles turns with no cost reported (costCents undefined)', async () => {
    const policy: RolloverPolicy = { contextPercent: 0.99, maxCostCentsPerSession: 50 };
    const controller = makeController({
      enabled: true,
      rolloverThreshold: 0.99,
      rolloverPolicy: policy,
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });

    // turn with no cost — should not trip
    const run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnNoCost('s1'));
    expect(run?.phase).toBe('working');
    expect(run?.sessionCostCents).toBe(0);
    expect(run?.totalCostCents).toBe(0);
  });
});

describe('v0.5: run resume', () => {
  beforeEach(async () => {
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('resumes a stopped run to active working', async () => {
    const controller = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    // do some work, then stop
    await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnNoCost('s1'));
    await controller.stopRun();

    const run = await controller.getState();
    expect(run?.status).toBe('stopped');
    expect(run?.phase).toBe('stopped');

    // resume
    const resumed = await controller.resumeRun();
    expect(resumed?.status).toBe('active');
    expect(resumed?.phase).toBe('working');
    expect(resumed?.workerGeneration).toBe(1); // preserved
    expect(resumed?.originalObjective).toBe('do work'); // preserved
  });

  it('throws when resuming a non-stopped run', async () => {
    const controller = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    // run is active — resume should throw
    expect(controller.resumeRun()).rejects.toThrow('Cannot resume a run in status');
  });

  it('returns null when there is no run to resume', async () => {
    const controller = makeController();
    const resumed = await controller.resumeRun();
    expect(resumed).toBeNull();
  });

  it('resumes a stopped-while-verifying run to active verifying', async () => {
    const controller = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });
    // worker completes → verifying
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', turnNoCost('s1'));
    expect(run?.phase).toBe('verifying');
    // stop mid-verification
    await controller.stopRun();
    expect((await controller.getState())?.phase).toBe('stopped');

    // resume — should restore to verifying
    const resumed = await controller.resumeRun();
    expect(resumed?.status).toBe('active');
    expect(resumed?.phase).toBe('verifying');
    expect(resumed?.verificationAttempt).toBe(1); // preserved
  });

  it('preserves handoff + session lineage across stop/resume', async () => {
    const controller = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    // trigger a rollover so a handoff exists
    await controller.onContextUsage('s1', 160000, 200000); // 80%
    await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnNoCost('s1'));
    const beforeStop = await controller.getState();
    expect(beforeStop?.handoff).toBeDefined();
    expect(beforeStop?.workerGeneration).toBe(2);

    await controller.stopRun();
    const resumed = await controller.resumeRun();
    expect(resumed?.handoff).toBeDefined(); // preserved
    expect(resumed?.workerGeneration).toBe(2); // preserved
  });

  it('can resume, do more work, and complete', async () => {
    const controller = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });
    await controller.stopRun();
    await controller.resumeRun();

    // worker completes after resume
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', turnNoCost('s1'));
    expect(run?.phase).toBe('verifying');
    expect(run?.verificationAttempt).toBe(1);

    // verifier passes
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: PASS',
      turnNoCost(run!.currentSessionId, 'verification')
    );
    expect(run?.status).toBe('completed');
  });
});
