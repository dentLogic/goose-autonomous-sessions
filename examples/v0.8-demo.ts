// examples/v0.8-demo.ts
//
// Run with:  bun examples/v0.8-demo.ts
//
// Demonstrates the v0.8 features:
//   1. Configurable retry policy (maxAttempts + backoffMs + exponential)
//   2. Webhook delivery log inspection
//
// Shows how different webhooks can have different retry policies.
import {
  createWebhookNotifier,
  getDeliveryLog,
  clearDeliveryLog,
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
  console.log('\n\x1b[1m🤖 goose-autonomous-sessions — v0.8 demo\x1b[0m');
  console.log('   configurable retry policy + delivery log\x1b[0m\n');

  clearDeliveryLog();

  // Three webhooks with different retry policies:
  // 1. No retry policy → default (2 attempts, 2s delay)
  // 2. maxAttempts=1 → no retry
  // 3. Exponential backoff, 3 attempts
  const notifier = createWebhookNotifier(
    [
      {
        url: 'http://127.0.0.1:1/default',
        // no retry policy → default (2 attempts, 2s delay)
      },
      {
        url: 'http://127.0.0.1:1/no-retry',
        retry: { maxAttempts: 1 },
      },
      {
        url: 'http://127.0.0.1:1/exponential',
        retry: {
          maxAttempts: 3,
          backoffMs: 100,
          backoffStrategy: 'exponential' as const,
        },
      },
    ],
    consoleLogger
  );

  console.log('Emitting run.started to 3 webhooks (all unreachable)...\n');
  const start = Date.now();
  await notifier(makePayload('run.started'));
  // wait for all retries to complete
  await new Promise((r) => setTimeout(r, 3000));
  const elapsed = Date.now() - start;

  console.log(`\nAll deliveries completed in ${elapsed}ms\n`);

  // ─── delivery log ─────────────────────────────────────────────────────────
  console.log('\x1b[1m─── delivery log ───\x1b[0m\n');
  const log = getDeliveryLog(50, 'demo-run');
  for (const rec of log) {
    const url = rec.url.replace('http://127.0.0.1:1/', '');
    console.log(
      `  ${url.padEnd(14)} attempt ${rec.attempt} → ${rec.result}` +
      (rec.error ? ` (${rec.error.slice(0, 40)})` : '')
    );
  }

  console.log('\n\x1b[1m─── summary ───\x1b[0m');
  console.log(`  default retry:     attempt ${log.find((l) => l.url.endsWith('/default'))?.attempt} (expected 2)`);
  console.log(`  no-retry:          attempt ${log.find((l) => l.url.endsWith('/no-retry'))?.attempt} (expected 1)`);
  console.log(`  exponential (3x):  attempt ${log.find((l) => l.url.endsWith('/exponential'))?.attempt} (expected 3)`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
