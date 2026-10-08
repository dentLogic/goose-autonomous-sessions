// examples/v0.6-demo.ts
//
// Run with:  bun examples/v0.6-demo.ts
//
// Demonstrates the v0.6 features:
//   1. Cost-based run budget (maxTotalCostCents — halts the entire run)
//   2. Webhook notifications (captures events instead of HTTP for the demo)
//
// Watch the controller emit webhooks at every transition, then halt when the
// total run cost exceeds the budget.
import { AutonomousSessionController } from '../src/autonomous/controller';
import { inMemoryStore, consoleLogger } from './in-memory-adapters';
import type { WebhookPayload } from '../src/autonomous/types';

// ─── webhook capture ──────────────────────────────────────────────────────────
const delivered: WebhookPayload[] = [];
async function capturingNotifier(payload: WebhookPayload): Promise<void> {
  delivered.push(payload);
  const cost = payload.run.totalCostCents ? ` ($${(payload.run.totalCostCents / 100).toFixed(2)})` : '';
  await consoleLogger.info(`[webhook] ${payload.event}${cost}`);
}

// ─── controller ───────────────────────────────────────────────────────────────
const controller = new AutonomousSessionController({
  store: inMemoryStore,
  logger: consoleLogger,
  generateHandoffResponse: async () =>
    JSON.stringify({
      currentState: 'Mid-task.',
      completedWork: ['some work'],
      remainingWork: ['more work'],
      filesChanged: ['src/foo.ts'],
      tests: [{ command: 'npm test', result: 'PASS' }],
      failures: [],
      decisions: ['decided X'],
      constraints: ['must be fast'],
      nextAction: 'continue the work',
    }),
  sendPrompt: async () => {},
  webhookNotifier: capturingNotifier,
  settings: {
    enabled: true,
    rolloverThreshold: 0.99,
    rolloverPolicy: { contextPercent: 0.99, maxTurnsPerSession: 2 },
    maxTotalCostCents: 75, // $0.75 budget
  },
});

// ─── simulate ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[1m🤖 goose-autonomous-sessions — v0.6 demo\x1b[0m');
  console.log('   cost-based run budget ($0.75) + webhook notifications\x1b[0m\n');
  console.log('Objective: "Build a feature that keeps costing money."\n');

  const run = await controller.startRun({
    sessionId: 'user-session-1',
    objective: 'Build a feature that keeps costing money.',
    settings: { enabled: true, rolloverThreshold: 0.99 },
  });

  let currentSessionId = run.currentSessionId;
  let turnCount = 0;

  for (let i = 1; i <= 10; i++) {
    const state = await controller.getState();
    if (!state || state.status !== 'active') {
      console.log(`\n── run halted at step ${i} (status: ${state?.status}) ──`);
      break;
    }
    currentSessionId = state.currentSessionId;

    turnCount += 1;
    const willComplete = turnCount >= 2;
    const marker = willComplete ? 'AUTONOMOUS_STATUS: COMPLETE' : 'AUTONOMOUS_STATUS: CONTINUE';
    const cost = 20 + Math.floor(Math.random() * 15); // 20-35¢ per turn

    console.log(`\n\x1b[1m── step ${i}: worker turn ${turnCount} (cost: ${cost}¢) → ${marker.split(': ')[1]}\x1b[0m`);

    await controller.onTurnFinished(currentSessionId, `did some work\n\n${marker}`, {
      sessionId: currentSessionId,
      turnIndex: i,
      role: 'worker',
      summary: 'work',
      filesTouched: [],
      testsRun: [],
      contextBefore: 0,
      contextAfter: 10,
      ts: new Date().toISOString(),
      costCents: cost,
    });

    if (willComplete) turnCount = 0;

    // If we rolled over (new session), continue; if we hit verifying, fail it
    const newState = await controller.getState();
    if (newState?.phase === 'verifying') {
      console.log(`\n\x1b[1m── step ${i}: verification → FAIL ──\x1b[0m`);
      await controller.onTurnFinished(
        newState.currentSessionId,
        'AUTONOMOUS_VERIFICATION: FAIL\n- still incomplete',
        {
          sessionId: newState.currentSessionId,
          turnIndex: i,
          role: 'verification',
          summary: 'FAIL',
          filesTouched: [],
          testsRun: [],
          contextBefore: 0,
          contextAfter: 0,
          ts: new Date().toISOString(),
        }
      );
    }
  }

  // ─── summary ────────────────────────────────────────────────────────────────
  const final = await controller.getState();
  await new Promise((r) => setTimeout(r, 100)); // let webhooks flush

  console.log('\n\x1b[1m─── v0.6 demo summary ───\x1b[0m');
  console.log(`  final status:  \x1b[${final?.status === 'error' ? '31' : '32'}m${final?.status}\x1b[0m`);
  console.log(`  total cost:    $${((final?.totalCostCents ?? 0) / 100).toFixed(2)} (budget: $0.75)`);
  console.log(`  worker gen:    ${final?.workerGeneration}`);
  if (final?.lastError) {
    console.log(`  last error:    \x1b[31m${final.lastError}\x1b[0m`);
  }
  console.log(`\n  webhooks emitted: ${delivered.length}`);
  for (const w of delivered) {
    const cost = w.run.totalCostCents ? ` ($${(w.run.totalCostCents / 100).toFixed(2)})` : '';
    console.log(`    • ${w.event}${cost}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
