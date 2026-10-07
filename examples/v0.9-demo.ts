// examples/v0.9-demo.ts
//
// Run with:  bun examples/v0.9-demo.ts
//
// Demonstrates the v0.9 features:
//   1. Webhook retry jitter (randomized backoff)
//   2. Webhook event replay (re-deliver failed events)
//
// Shows failed deliveries being replayed.
import {
  clearDeliveryLog,
  createWebhookNotifier,
  getDeliveryLog,
  getReplayableDeliveries,
  replayFailedDeliveries,
} from '../src/autonomous/webhooks';
import { consoleLogger } from './in-memory-adapters';
import { buildRunSnapshot } from '../src/autonomous/webhooks';

function makePayload(event: any, runId = 'demo-run') {
  return {
    event,
    runId,
    emittedAt: new Date().toISOString(),
    run: buildRunSnapshot({
      status: 'active',
      phase: 'working',
      workerGeneration: 1,
      verificationAttempt: 0,
    }),
  };
}

async function main() {
  console.log('\n\x1b[1m🤖 goose-autonomous-sessions — v0.9 demo\x1b[0m');
  console.log('   webhook jitter + event replay\x1b[0m\n');

  clearDeliveryLog();

  // ── jitter demo ─────────────────────────────────────────────────────────────
  console.log('\x1b[1m─── jitter demo ───\x1b[0m');
  console.log('  Two webhooks with the same backoff (200ms), one with jitter:\n');

  const jitterDelays: number[] = [];
  const noJitterDelays: number[] = [];

  for (let i = 0; i < 3; i++) {
    clearDeliveryLog();

    // With jitter
    let start = Date.now();
    const notifierJitter = createWebhookNotifier(
      [{
        url: 'http://127.0.0.1:1/unreachable',
        retry: { maxAttempts: 2, backoffMs: 200, jitter: true },
      }],
      consoleLogger
    );
    await notifierJitter(makePayload('run.started', `run-jitter-${i}`));
    await new Promise((r) => setTimeout(r, 600));
    jitterDelays.push(Date.now() - start);

    clearDeliveryLog();

    // Without jitter
    start = Date.now();
    const notifierNoJitter = createWebhookNotifier(
      [{
        url: 'http://127.0.0.1:1/unreachable',
        retry: { maxAttempts: 2, backoffMs: 200, jitter: false },
      }],
      consoleLogger
    );
    await notifierNoJitter(makePayload('run.started', `run-nojitter-${i}`));
    await new Promise((r) => setTimeout(r, 600));
    noJitterDelays.push(Date.now() - start);
  }

  console.log('\n  with jitter:    ', jitterDelays.map((d) => `${d}ms`).join(', '));
  console.log('  without jitter: ', noJitterDelays.map((d) => `${d}ms`).join(', '));
  console.log('  (jitter adds 0–50% randomness — delays vary more)');

  // ── replay demo ─────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m─── replay demo ───\x1b[0m\n');
  clearDeliveryLog();

  // Create 2 failed deliveries
  const notifier = createWebhookNotifier(
    [{
      url: 'http://127.0.0.1:1/unreachable',
      retry: { maxAttempts: 1 }, // fail immediately
      secret: 'replay-secret',
    }],
    consoleLogger
  );
  await notifier(makePayload('run.completed', 'replay-demo'));
  await notifier(makePayload('run.failed', 'replay-demo'));
  await new Promise((r) => setTimeout(r, 200));

  const failedBefore = getDeliveryLog(100, 'replay-demo').filter((l) => l.result === 'failed');
  console.log(`  Created ${failedBefore.length} failed deliveries`);
  for (const f of failedBefore) {
    console.log(`    • ${f.event} → ${f.url} (payload stored: ${!!f.payload}, config stored: ${!!f.config})`);
  }

  const replayable = getReplayableDeliveries('replay-demo');
  console.log(`\n  Replayable deliveries: ${replayable.length}`);

  // Replay them (URL still unreachable, so they'll fail again — but with new records)
  console.log('\n  Replaying...');
  const replayedCount = await replayFailedDeliveries(consoleLogger, 'replay-demo');
  await new Promise((r) => setTimeout(r, 200));

  const failedAfter = getDeliveryLog(100, 'replay-demo').filter((l) => l.result === 'failed');
  console.log(`\n  Replayed: ${replayedCount} deliveries`);
  console.log(`  Failed records after replay: ${failedAfter.length} (original + replay attempts)`);
  console.log(`  (original records preserved — new records appended for replays)`);

  console.log('\n\x1b[1m─── v0.9 demo summary ───\x1b[0m');
  console.log(`  jitter: randomized backoff delays to avoid thundering-herd`);
  console.log(`  replay: re-deliver failed webhook events from the delivery log`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
