// tests/v0.6-integration.test.ts
// v0.6 — cost-based run budget + webhook notifications.
import { describe, it, expect, beforeEach } from 'bun:test';
import { AutonomousSessionController } from '../src/autonomous/controller';
import { inMemoryStore } from '../examples/in-memory-adapters';
import type { AutonomousSettings, WebhookPayload, WebhookEvent } from '../src/autonomous/types';

const silentLogger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {},
};

// Capture webhooks for assertion
function makeCapturingNotifier() {
  const delivered: WebhookPayload[] = [];
  const notifier = async (payload: WebhookPayload) => {
    delivered.push(payload);
  };
  return { notifier, delivered };
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

describe('v0.6: cost-based run budget', () => {
  beforeEach(async () => {
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('halts the run when total cost exceeds the budget', async () => {
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
      settings: {
        enabled: true,
        rolloverThreshold: 0.99,
        maxTotalCostCents: 100, // $1.00 total budget
      },
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });

    // turn 1: 60¢ — under budget
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 60));
    expect(run?.status).toBe('active');
    expect(run?.totalCostCents).toBe(60);

    // turn 2: +50¢ = 110¢ — over budget (100¢) → halt
    run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 50));
    expect(run?.status).toBe('error');
    expect(run?.phase).toBe('error');
    expect(run?.lastError).toContain('Run cost budget exhausted');
    expect(run?.lastError).toContain('110¢ / 100¢');
  });

  it('does NOT halt when total cost is below the budget', async () => {
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
      settings: { enabled: true, rolloverThreshold: 0.99, maxTotalCostCents: 200 },
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });

    const run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 50));
    expect(run?.status).toBe('active');
    expect(run?.totalCostCents).toBe(50);
  });

  it('unlimited budget when maxTotalCostCents is undefined (backward compat)', async () => {
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });

    // 1000¢ — should NOT halt (no budget set)
    const run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 1000));
    expect(run?.status).toBe('active');
  });

  it('budget is independent of per-session rollover cost policy', async () => {
    // Per-session cost policy triggers rollover at 30¢; run budget halts at 100¢
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
      settings: {
        enabled: true,
        rolloverThreshold: 0.99,
        rolloverPolicy: { contextPercent: 0.99, maxCostCentsPerSession: 30 },
        maxTotalCostCents: 100,
      },
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });

    // turn 1: 35¢ → rollover (per-session 35 >= 30), total = 35
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 35));
    expect(run?.workerGeneration).toBe(2);
    expect(run?.totalCostCents).toBe(35);

    // worker 2 turn 1: 40¢ → rollover again (per-session 40 >= 30), total = 75
    run = await controller.onTurnFinished(run!.currentSessionId, 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost(run!.currentSessionId, 40));
    expect(run?.workerGeneration).toBe(3);
    expect(run?.totalCostCents).toBe(75);

    // worker 3 turn 1: 30¢ → rollover, total = 105 > 100 → halt
    run = await controller.onTurnFinished(run!.currentSessionId, 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost(run!.currentSessionId, 30));
    expect(run?.status).toBe('error');
    expect(run?.lastError).toContain('cost budget exhausted');
  });
});

describe('v0.6: webhook notifications', () => {
  beforeEach(async () => {
    await inMemoryStore.clearRun();
    await inMemoryStore.clearSessions();
  });

  it('emits run.started on startRun', async () => {
    const { notifier, delivered } = makeCapturingNotifier();
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () => '{}',
      sendPrompt: async () => {},
      webhookNotifier: notifier,
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    // webhooks are fire-and-forget; give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered.length).toBe(1);
    expect(delivered[0].event).toBe('run.started');
    expect(delivered[0].run.workerGeneration).toBe(1);
  });

  it('emits rollover.completed on rollover', async () => {
    const { notifier, delivered } = makeCapturingNotifier();
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
      webhookNotifier: notifier,
      settings: {
        enabled: true,
        rolloverThreshold: 0.99,
        rolloverPolicy: { maxTurnsPerSession: 1 },
      },
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });
    // run.started
    await new Promise((r) => setTimeout(r, 10));
    // turn 1 → rollover
    await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnNoCost('s1'));
    await new Promise((r) => setTimeout(r, 10));

    const events = delivered.map((d) => d.event);
    expect(events).toContain('run.started');
    expect(events).toContain('rollover.completed');
    const rolloverEvent = delivered.find((d) => d.event === 'rollover.completed')!;
    expect(rolloverEvent.run.workerGeneration).toBe(2);
    expect(rolloverEvent.details?.workerGeneration).toBe(2);
  });

  it('emits verification.started + verification.passed + run.completed on PASS', async () => {
    const { notifier, delivered } = makeCapturingNotifier();
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
      webhookNotifier: notifier,
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });
    await new Promise((r) => setTimeout(r, 10));

    // worker completes → verifying
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', turnNoCost('s1'));
    await new Promise((r) => setTimeout(r, 10));

    // verifier passes
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: PASS',
      turnNoCost(run!.currentSessionId, 'verification')
    );
    await new Promise((r) => setTimeout(r, 10));

    const events = delivered.map((d) => d.event);
    expect(events).toContain('verification.started');
    expect(events).toContain('verification.passed');
    expect(events).toContain('run.completed');
  });

  it('emits verification.failed on FAIL', async () => {
    const { notifier, delivered } = makeCapturingNotifier();
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
      webhookNotifier: notifier,
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });
    await new Promise((r) => setTimeout(r, 10));

    // worker completes → verifying
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', turnNoCost('s1'));
    await new Promise((r) => setTimeout(r, 10));

    // verifier fails
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: FAIL\n- not done',
      turnNoCost(run!.currentSessionId, 'verification')
    );
    await new Promise((r) => setTimeout(r, 10));

    const events = delivered.map((d) => d.event);
    expect(events).toContain('verification.started');
    expect(events).toContain('verification.failed');
    const failEvent = delivered.find((d) => d.event === 'verification.failed')!;
    expect(failEvent.details?.findings).toBeDefined();
  });

  it('emits run.failed on verification budget exhaustion', async () => {
    const { notifier, delivered } = makeCapturingNotifier();
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
      webhookNotifier: notifier,
      settings: {
        enabled: true,
        rolloverThreshold: 0.99,
        maxVerificationAttempts: 1,
      },
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });
    await new Promise((r) => setTimeout(r, 10));

    // worker 1 completes → verifier 1 → fail
    let run = await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: COMPLETE', turnNoCost('s1'));
    run = await controller.onTurnFinished(
      run!.currentSessionId,
      'AUTONOMOUS_VERIFICATION: FAIL\n- not done',
      turnNoCost(run!.currentSessionId, 'verification')
    );
    await new Promise((r) => setTimeout(r, 10));

    // worker 2 completes → should hit budget
    run = await controller.onTurnFinished(run!.currentSessionId, 'AUTONOMOUS_STATUS: COMPLETE', turnNoCost(run!.currentSessionId));
    await new Promise((r) => setTimeout(r, 10));

    expect(run?.status).toBe('error');
    const events = delivered.map((d) => d.event);
    expect(events).toContain('run.failed');
    const failEvent = delivered.find((d) => d.event === 'run.failed')!;
    expect(failEvent.details?.reason).toBe('verification budget exhausted');
  });

  it('emits budget.exhausted on cost budget exhaustion', async () => {
    const { notifier, delivered } = makeCapturingNotifier();
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () =>
        JSON.stringify({
          currentState: 'mid', completedWork: ['a'], remainingWork: ['b'],
          filesChanged: ['f.ts'], tests: [], failures: [], decisions: [], constraints: [],
          nextAction: 'do b',
        }),
      sendPrompt: async () => {},
      webhookNotifier: notifier,
      settings: {
        enabled: true,
        rolloverThreshold: 0.99,
        maxTotalCostCents: 50,
      },
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.99 },
    });
    await new Promise((r) => setTimeout(r, 10));

    // turn costs 60¢ → exceeds 50¢ budget
    await controller.onTurnFinished('s1', 'AUTONOMOUS_STATUS: CONTINUE', turnWithCost('s1', 60));
    await new Promise((r) => setTimeout(r, 10));

    const events = delivered.map((d) => d.event);
    expect(events).toContain('budget.exhausted');
    const budgetEvent = delivered.find((d) => d.event === 'budget.exhausted')!;
    expect(budgetEvent.details?.totalCostCents).toBe(60);
    expect(budgetEvent.details?.maxTotalCostCents).toBe(50);
  });

  it('emits run.stopped + run.resumed on stop/resume', async () => {
    const { notifier, delivered } = makeCapturingNotifier();
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () => '{}',
      sendPrompt: async () => {},
      webhookNotifier: notifier,
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await new Promise((r) => setTimeout(r, 10));

    await controller.stopRun();
    await new Promise((r) => setTimeout(r, 10));

    await controller.resumeRun();
    await new Promise((r) => setTimeout(r, 10));

    const events = delivered.map((d) => d.event);
    expect(events).toContain('run.stopped');
    expect(events).toContain('run.resumed');
  });

  it('no-op when no webhooks configured (backward compat)', async () => {
    // No webhookNotifier injected, no settings.webhooks → should not throw
    const controller = new AutonomousSessionController({
      store: inMemoryStore,
      logger: silentLogger as any,
      generateHandoffResponse: async () => '{}',
      sendPrompt: async () => {},
    });
    await controller.startRun({
      sessionId: 's1',
      objective: 'do work',
      settings: { enabled: true, rolloverThreshold: 0.75 },
    });
    await new Promise((r) => setTimeout(r, 10));
    // should not throw — no-op notifier
    expect(true).toBe(true);
  });
});
