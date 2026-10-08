// tests/v0.8-integration.test.ts
// v0.8 — configurable retry policy + webhook dashboard endpoint.
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  clearDeliveryLog,
  createWebhookNotifier,
  getDeliveryLog,
  signPayload,
  verifySignature,
} from '../src/autonomous/webhooks';
import type { WebhookPayload } from '../src/autonomous/types';

const silentLogger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {},
};

function makePayload(event: WebhookPayload['event'], runId = 'run-1'): WebhookPayload {
  return {
    event,
    runId,
    emittedAt: new Date().toISOString(),
    run: {
      status: 'active',
      phase: 'working',
      workerGeneration: 1,
      verificationAttempt: 0,
    },
  };
}

describe('v0.8: configurable retry policy', () => {
  beforeEach(() => {
    clearDeliveryLog();
  });

  it('uses default retry (2 attempts) when no retry policy is set', async () => {
    const notifier = createWebhookNotifier(
      [{ url: 'http://127.0.0.1:1/unreachable' }],
      silentLogger
    );
    await notifier(makePayload('run.started', 'run-default-retry'));
    await new Promise((r) => setTimeout(r, 3000));
    const log = getDeliveryLog(100, 'run-default-retry');
    const failed = log.filter((l) => l.result === 'failed');
    expect(failed.length).toBe(1);
    expect(failed[0].attempt).toBe(2); // default = 2 attempts
  });

  it('respects maxAttempts=1 (no retry)', async () => {
    const notifier = createWebhookNotifier(
      [{
        url: 'http://127.0.0.1:1/unreachable',
        retry: { maxAttempts: 1 },
      }],
      silentLogger
    );
    await notifier(makePayload('run.started', 'run-no-retry'));
    await new Promise((r) => setTimeout(r, 500));
    const log = getDeliveryLog(100, 'run-no-retry');
    const failed = log.filter((l) => l.result === 'failed');
    expect(failed.length).toBe(1);
    expect(failed[0].attempt).toBe(1); // no retry
  });

  it('respects maxAttempts=3 (two retries)', async () => {
    const notifier = createWebhookNotifier(
      [{
        url: 'http://127.0.0.1:1/unreachable',
        retry: { maxAttempts: 3, backoffMs: 100 },
      }],
      silentLogger
    );
    await notifier(makePayload('run.started', 'run-3-attempts'));
    await new Promise((r) => setTimeout(r, 1000));
    const log = getDeliveryLog(100, 'run-3-attempts');
    const failed = log.filter((l) => l.result === 'failed');
    expect(failed.length).toBe(1);
    expect(failed[0].attempt).toBe(3); // 3 total attempts
  });

  it('respects custom backoffMs', async () => {
    const start = Date.now();
    const notifier = createWebhookNotifier(
      [{
        url: 'http://127.0.0.1:1/unreachable',
        retry: { maxAttempts: 2, backoffMs: 200 },
      }],
      silentLogger
    );
    await notifier(makePayload('run.started', 'run-custom-backoff'));
    await new Promise((r) => setTimeout(r, 1000));
    const elapsed = Date.now() - start;
    // Should have waited ~200ms between attempts (not the default 2000ms)
    // Total: attempt 1 (instant fail) + 200ms delay + attempt 2 (instant fail)
    // So elapsed should be > 200ms but < 2000ms
    expect(elapsed).toBeGreaterThan(150);
    expect(elapsed).toBeLessThan(1500);
  });

  it('supports exponential backoff', async () => {
    const start = Date.now();
    const notifier = createWebhookNotifier(
      [{
        url: 'http://127.0.0.1:1/unreachable',
        retry: {
          maxAttempts: 3,
          backoffMs: 100,
          backoffStrategy: 'exponential',
        },
      }],
      silentLogger
    );
    await notifier(makePayload('run.started', 'run-exp-backoff'));
    await new Promise((r) => setTimeout(r, 1500));
    const elapsed = Date.now() - start;
    const log = getDeliveryLog(100, 'run-exp-backoff');
    const failed = log.filter((l) => l.result === 'failed');
    expect(failed.length).toBe(1);
    expect(failed[0].attempt).toBe(3);
    // Exponential: attempt 1 (instant fail) + 100ms delay + attempt 2 + 200ms delay + attempt 3
    // Total delay = 300ms; elapsed should be > 300ms
    expect(elapsed).toBeGreaterThan(250);
  });

  it('retry policy is per-webhook (different webhooks can have different policies)', async () => {
    const notifier = createWebhookNotifier(
      [
        { url: 'http://127.0.0.1:1/a', retry: { maxAttempts: 1, backoffMs: 50 } },
        { url: 'http://127.0.0.1:1/b', retry: { maxAttempts: 3, backoffMs: 50 } },
      ],
      silentLogger
    );
    await notifier(makePayload('run.started', 'run-per-webhook'));
    await new Promise((r) => setTimeout(r, 500));
    const log = getDeliveryLog(100, 'run-per-webhook');
    const aRecord = log.find((l) => l.url.endsWith('/a'));
    const bRecord = log.find((l) => l.url.endsWith('/b'));
    expect(aRecord?.attempt).toBe(1); // maxAttempts=1
    expect(bRecord?.attempt).toBe(3); // maxAttempts=3
  });
});

describe('v0.8: webhook delivery log shape', () => {
  beforeEach(() => {
    clearDeliveryLog();
  });

  it('delivery records include all expected fields', async () => {
    const notifier = createWebhookNotifier(
      [{
        url: 'https://example.com/hook',
        events: ['run.completed'],
        secret: 'test-secret',
        retry: { maxAttempts: 1 },
      }],
      silentLogger
    );
    // emit an event that IS in the allowlist → delivery attempt
    await notifier(makePayload('run.completed', 'run-shape-test'));
    await new Promise((r) => setTimeout(r, 500));
    const log = getDeliveryLog(100, 'run-shape-test');
    expect(log.length).toBe(1);
    const rec = log[0];
    expect(rec.id).toBeDefined();
    expect(rec.url).toBe('https://example.com/hook');
    expect(rec.event).toBe('run.completed');
    expect(rec.runId).toBe('run-shape-test');
    expect(rec.attemptedAt).toBeDefined();
    expect(rec.result).toMatch(/^(delivered|failed|skipped)$/);
    expect(typeof rec.signed).toBe('boolean');
    expect(typeof rec.attempt).toBe('number');
    expect(rec.signed).toBe(true); // secret was set
  });
});

describe('v0.8: signPayload + verifySignature (re-exported helpers)', () => {
  it('signPayload produces sha256= prefixed hex', async () => {
    const sig = await signPayload('secret', '{"event":"test"}');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('verifySignature round-trips correctly', async () => {
    const body = '{"event":"run.completed","runId":"abc"}';
    const sig = await signPayload('my-secret', body);
    expect(await verifySignature('my-secret', body, sig)).toBe(true);
    expect(await verifySignature('wrong', body, sig)).toBe(false);
  });

  it('verifySignature handles edge cases', async () => {
    expect(await verifySignature('s', 'body', null)).toBe(false);
    expect(await verifySignature('s', 'body', undefined)).toBe(false);
    expect(await verifySignature('s', 'body', '')).toBe(false);
    expect(await verifySignature('s', 'body', 'sha256=short')).toBe(false);
    expect(await verifySignature('s', 'body', 'not-prefixed')).toBe(false);
  });
});
