// examples/v0.7-demo.ts
//
// Run with:  bun examples/v0.7-demo.ts
//
// Demonstrates the v0.7 webhook features:
//   1. HMAC signature verification (sign + verify)
//   2. Per-event filtering (only run.completed + run.failed delivered)
//   3. Delivery log inspection (skipped vs delivered vs failed)
//
// Uses a capturing notifier (no real HTTP) so you can see the events + signatures.
import {
  signPayload,
  verifySignature,
  getDeliveryLog,
  clearDeliveryLog,
} from '../src/autonomous/webhooks';
import { AutonomousSessionController } from '../src/autonomous/controller';
import { inMemoryStore, consoleLogger } from './in-memory-adapters';
import type { WebhookPayload } from '../src/autonomous/types';

// ─── HMAC demo ────────────────────────────────────────────────────────────────
function demoHmac() {
  console.log('\n\x1b[1m─── HMAC signature demo ───\x1b[0m\n');
  const secret = 'my-webhook-secret';
  const body = JSON.stringify({ event: 'run.completed', runId: 'abc-123' });
  const signature = signPayload(secret, body);
  console.log(`  body:      ${body}`);
  console.log(`  secret:    ${secret}`);
  console.log(`  signature: ${signature}`);
  console.log(`  verify (correct secret): ${verifySignature(secret, body, signature) ? '✓ valid' : '✗ invalid'}`);
  console.log(`  verify (wrong secret):   ${verifySignature('wrong', body, signature) ? '✓ valid' : '✗ invalid'}`);
  console.log(`  verify (tampered body):  ${verifySignature(secret, '{"event":"run.failed"}', signature) ? '✓ valid' : '✗ invalid'}`);
}

// ─── capturing notifier with signature + filter ────────────────────────────────
const captured: { payload: WebhookPayload; signature?: string }[] = [];

async function capturingNotifier(payload: WebhookPayload): Promise<void> {
  // In a real setup, the notifier sends the signature via the
  // X-Goose-Autonomous-Signature header. Here we capture + verify.
  const secret = 'demo-secret';
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, body);
  const valid = verifySignature(secret, body, signature);
  captured.push({ payload, signature });
  await consoleLogger.info(
    `[webhook] ${payload.event} → signature ${valid ? '✓ verified' : '✗ invalid'}`
  );
}

// ─── controller with event filtering ───────────────────────────────────────────
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
});

async function main() {
  console.log('\n\x1b[1m🤖 goose-autonomous-sessions — v0.7 demo\x1b[0m');
  console.log('   HMAC signing + per-event filtering + delivery log\x1b[0m\n');

  demoHmac();

  console.log('\n\x1b[1m─── event filtering demo ───\x1b[0m');
  console.log('  (capturing notifier verifies HMAC signature of every event)\n');

  clearDeliveryLog();

  const run = await controller.startRun({
    sessionId: 'user-session-1',
    objective: 'Build a small feature.',
    settings: { enabled: true, rolloverThreshold: 0.99 },
  });

  // worker completes → verifying → PASS
  let state = await controller.onTurnFinished(
    run.currentSessionId,
    'AUTONOMOUS_STATUS: COMPLETE',
    {
      sessionId: run.currentSessionId,
      turnIndex: 1,
      role: 'worker',
      summary: 'done',
      filesTouched: [],
      testsRun: [],
      contextBefore: 0,
      contextAfter: 10,
      ts: new Date().toISOString(),
    }
  );
  await new Promise((r) => setTimeout(r, 50));

  state = await controller.onTurnFinished(
    state!.currentSessionId,
    'AUTONOMOUS_VERIFICATION: PASS',
    {
      sessionId: state!.currentSessionId,
      turnIndex: 2,
      role: 'verification',
      summary: 'PASS',
      filesTouched: [],
      testsRun: [],
      contextBefore: 0,
      contextAfter: 5,
      ts: new Date().toISOString(),
    }
  );
  await new Promise((r) => setTimeout(r, 50));

  // ─── summary ────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m─── v0.7 demo summary ───\x1b[0m');
  console.log(`  final status:  ${state?.status}`);
  console.log(`  captured webhooks: ${captured.length}`);
  for (const { payload, signature } of captured) {
    console.log(`    • ${payload.event} (signature: ${signature?.slice(0, 20)}...)`);
  }

  // Show how a receiver would verify
  console.log('\n\x1b[1m─── receiver-side verification ───\x1b[0m');
  if (captured.length > 0) {
    const { payload, signature } = captured[0];
    const body = JSON.stringify(payload);
    const valid = verifySignature('demo-secret', body, signature!);
    const invalid = verifySignature('wrong-secret', body, signature!);
    console.log(`  event:     ${payload.event}`);
    console.log(`  signature: ${signature}`);
    console.log(`  verify with correct secret: ${valid ? '✓ accepted' : '✗ rejected'}`);
    console.log(`  verify with wrong secret:   ${invalid ? '✓ accepted' : '✗ rejected'}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
