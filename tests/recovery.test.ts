// tests/recovery.test.ts
// Spec sections 17, 18, 36, 37, 38, 44, 71 — crash recovery.
import { describe, it, expect, beforeEach } from 'bun:test';
import { AutonomousSessionController } from '../src/autonomous/controller';
import { recover } from '../src/autonomous/recovery';
import { inMemoryStore } from '../examples/in-memory-adapters';
import type { AutonomousRun } from '../src/autonomous/types';

const silentLogger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {},
};

function makeController(run?: AutonomousRun | null) {
  return new AutonomousSessionController({
    store: inMemoryStore,
    logger: silentLogger as any,
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

async function setRun(run: Partial<AutonomousRun> & { runId: string }): Promise<void> {
  const full: AutonomousRun = {
    schemaVersion: 1,
    runId: run.runId,
    status: run.status ?? 'active',
    phase: run.phase ?? 'working',
    originalObjective: run.originalObjective ?? 'obj',
    currentSessionId: run.currentSessionId ?? 's1',
    rolloverPending: run.rolloverPending ?? false,
    rolloverThreshold: run.rolloverThreshold ?? 0.75,
    workerGeneration: run.workerGeneration ?? 1,
    verificationAttempt: run.verificationAttempt ?? 0,
    createdAt: run.createdAt ?? new Date().toISOString(),
    updatedAt: run.updatedAt ?? new Date().toISOString(),
    ...run,
  } as AutonomousRun;
  await inMemoryStore.saveRun(full);
}

describe('recovery decision tree', () => {
  beforeEach(async () => {
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('no run → returns null (nothing to do)', async () => {
    const c = makeController();
    const run = await recover(c);
    expect(run).toBeNull();
  });

  it('completed run → returned as-is', async () => {
    await setRun({ runId: 'r1', status: 'completed', phase: 'completed' });
    const c = makeController();
    const run = await recover(c);
    expect(run?.status).toBe('completed');
  });

  it('stopped run → left stopped', async () => {
    await setRun({ runId: 'r1', status: 'stopped', phase: 'stopped' });
    const c = makeController();
    const run = await recover(c);
    expect(run?.status).toBe('stopped');
  });

  it('working phase → reconnected (no change)', async () => {
    await setRun({ runId: 'r1', status: 'active', phase: 'working' });
    const c = makeController();
    const run = await recover(c);
    expect(run?.phase).toBe('working');
    expect(run?.status).toBe('active');
  });

  it('handoff phase → reset to working, rollover re-pending', async () => {
    await setRun({
      runId: 'r1',
      status: 'active',
      phase: 'handoff',
      rolloverPending: false,
      transitionId: 't1',
      transitionStage: undefined,
    });
    const c = makeController();
    const run = await recover(c);
    expect(run?.phase).toBe('working');
    expect(run?.rolloverPending).toBe(true);
    expect(run?.transitionId).toBeUndefined();
  });

  it('creating-session + pendingSessionId → resume pending session', async () => {
    await setRun({
      runId: 'r1',
      status: 'active',
      phase: 'creating-session',
      currentSessionId: 's-old',
      pendingSessionId: 's-pending',
      workerGeneration: 1,
    });
    const c = makeController();
    const run = await recover(c);
    expect(run?.phase).toBe('working');
    expect(run?.currentSessionId).toBe('s-pending');
    expect(run?.workerGeneration).toBe(2);
    expect(run?.contextUsage).toBe(0);
    expect(run?.transitionStage).toBe('session-active');
  });

  it('creating-session + NO pendingSessionId → reset to working, re-pending', async () => {
    await setRun({
      runId: 'r1',
      status: 'active',
      phase: 'creating-session',
      pendingSessionId: undefined,
    });
    const c = makeController();
    const run = await recover(c);
    expect(run?.phase).toBe('working');
    expect(run?.rolloverPending).toBe(true);
  });

  it('verifying phase → reconnect verifier (no change)', async () => {
    await setRun({
      runId: 'r1',
      status: 'active',
      phase: 'verifying',
      verificationAttempt: 1,
    });
    const c = makeController();
    const run = await recover(c);
    expect(run?.phase).toBe('verifying');
    expect(run?.verificationAttempt).toBe(1);
  });

  it('error phase → exposed (no silent recovery)', async () => {
    await setRun({
      runId: 'r1',
      status: 'error',
      phase: 'error',
      lastError: 'handoff generation failed',
    });
    const c = makeController();
    const run = await recover(c);
    expect(run?.status).toBe('error');
    expect(run?.lastError).toBe('handoff generation failed');
  });
});
