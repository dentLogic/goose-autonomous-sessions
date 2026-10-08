// tests/state-machine.test.ts
// Spec sections 69, 70, 74 — state machine + duplicate prevention + verifier.
import { describe, it, expect, beforeEach } from 'bun:test';
import { AutonomousSessionController } from '../src/autonomous/controller';
import { inMemoryStore, consoleLogger, getMemSessions } from '../examples/in-memory-adapters';

function makeController() {
  const store = inMemoryStore;
  // silence logs in tests
  const silentLogger = {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
  };
  const sentPrompts: { sessionId: string; origin: string; prompt: string }[] = [];
  const controller = new AutonomousSessionController({
    store,
    logger: silentLogger as any,
    generateHandoffResponse: async () =>
      JSON.stringify({
        currentState: 'mid-task',
        completedWork: ['item A'],
        remainingWork: ['item B'],
        filesChanged: ['src/foo.ts'],
        tests: [{ command: 'npm test', result: 'PASS' }],
        failures: [],
        decisions: ['decided X'],
        constraints: ['must be fast'],
        nextAction: 'do item B next',
      }),
    sendPrompt: async ({ sessionId, prompt, origin }) => {
      sentPrompts.push({ sessionId, origin, prompt });
    },
  });
  return { controller, sentPrompts };
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

describe('state machine — basic transitions', () => {
  beforeEach(async () => {
    // reset in-memory store
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('start → working', async () => {
    const { controller } = makeController();
    const run = await controller.startRun({
      sessionId: 's1',
      objective: 'build a thing',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    expect(run.phase).toBe('working');
    expect(run.status).toBe('active');
    expect(run.workerGeneration).toBe(1);
    expect(run.originalObjective).toBe('build a thing');
  });

  it('working + threshold → rollover pending (does NOT interrupt)', async () => {
    const { controller } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    const run = await controller.onContextUsage('s1', 150000, 200000); // 75% exactly
    expect(run?.rolloverPending).toBe(true);
    expect(run?.phase).toBe('working'); // still working — not interrupted
  });

  it('below threshold → no rollover pending', async () => {
    const { controller } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    const run = await controller.onContextUsage('s1', 100000, 200000); // 50%
    expect(run?.rolloverPending).toBe(false);
  });

  it('rollover pending + turn finish → fresh worker (generation 2)', async () => {
    const { controller, sentPrompts } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await controller.onContextUsage('s1', 160000, 200000); // 80%
    const run = await controller.onTurnFinished(
      's1',
      'did some work\n\nAUTONOMOUS_STATUS: CONTINUE',
      emptyTurn('s1')
    );
    expect(run?.phase).toBe('working');
    expect(run?.workerGeneration).toBe(2);
    expect(run?.currentSessionId).not.toBe('s1');
    expect(run?.rolloverPending).toBe(false);
    expect(run?.contextUsage).toBe(0);
    expect(sentPrompts.length).toBe(1);
    expect(sentPrompts[0].origin).toBe('continuation');
  });

  it('worker COMPLETE → verifying (fresh verifier)', async () => {
    const { controller, sentPrompts } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    const run = await controller.onTurnFinished(
      's1',
      'all done\n\nAUTONOMOUS_STATUS: COMPLETE',
      emptyTurn('s1')
    );
    expect(run?.phase).toBe('verifying');
    expect(run?.verificationAttempt).toBe(1);
    expect(sentPrompts.length).toBe(1);
    expect(sentPrompts[0].origin).toBe('verification');
  });

  it('verification PASS → completed', async () => {
    const { controller } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', emptyTurn('s1'));
    const run = await controller.onTurnFinished(
      (await controller.getState())!.currentSessionId,
      'verified\n\nAUTONOMOUS_VERIFICATION: PASS',
      emptyTurn('v1', 'verification')
    );
    expect(run?.status).toBe('completed');
    expect(run?.phase).toBe('completed');
  });

  it('verification FAIL → new worker with verifier findings', async () => {
    const { controller } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', emptyTurn('s1'));
    const verifierId = (await controller.getState())!.currentSessionId;
    const run = await controller.onTurnFinished(
      verifierId,
      'AUTONOMOUS_VERIFICATION: FAIL\n- tests missing\n- docs missing',
      emptyTurn(verifierId, 'verification')
    );
    expect(run?.phase).toBe('working');
    expect(run?.workerGeneration).toBe(2);
    expect(run?.handoff?.failures.length).toBeGreaterThan(0);
  });

  it('worker COMPLETE takes precedence over rollover pending', async () => {
    const { controller, sentPrompts } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await controller.onContextUsage('s1', 160000, 200000); // 80% — rollover pending
    const run = await controller.onTurnFinished(
      's1',
      'done despite full context\n\nAUTONOMOUS_STATUS: COMPLETE',
      emptyTurn('s1')
    );
    // Should go to verifying, NOT to a fresh worker rollover
    expect(run?.phase).toBe('verifying');
    expect(run?.verificationAttempt).toBe(1);
    expect(sentPrompts[0].origin).toBe('verification');
  });
});

describe('duplicate prevention', () => {
  beforeEach(async () => {
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('two context events crossing threshold → only one rollover', async () => {
    const { controller, sentPrompts } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await controller.onContextUsage('s1', 160000, 200000); // 80%
    await controller.onContextUsage('s1', 170000, 200000); // 85%
    await controller.onContextUsage('s1', 180000, 200000); // 90%
    await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1'));
    // Only one continuation prompt should have been sent (one rollover)
    expect(sentPrompts.filter((p) => p.origin === 'continuation').length).toBe(1);
  });

  it('concurrent turn-finish calls → only one transition', async () => {
    const { controller, sentPrompts } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await controller.onContextUsage('s1', 160000, 200000);
    // fire two onTurnFinished concurrently
    await Promise.all([
      controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1')),
      controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1')),
    ]);
    expect(sentPrompts.filter((p) => p.origin === 'continuation').length).toBe(1);
  });

  it('stop preserves state — does not delete sessions/handoff/logs', async () => {
    const { controller } = makeController();
    await controller.startRun({
      sessionId: 's1',
      objective: 'x',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await controller.onContextUsage('s1', 160000, 200000);
    await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', emptyTurn('s1'));
    const beforeStop = await controller.getState();
    const sessionsBefore = getMemSessions().length;
    await controller.stopRun();
    const afterStop = await controller.getState();
    expect(afterStop?.status).toBe('stopped');
    expect(afterStop?.phase).toBe('stopped');
    // handoff preserved
    expect(afterStop?.handoff).toBeDefined();
    // sessions preserved
    expect(getMemSessions().length).toBe(sessionsBefore);
  });
});
