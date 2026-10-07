// tests/v0.7-integration.test.ts
// v0.7 — HMAC signature + event filtering + delivery log.
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  buildRunSnapshot,
  clearDeliveryLog,
  createWebhookNotifier,
  getDeliveryLog,
  normalizeWebhooks,
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
    run: buildRunSnapshot({
      status: 'active',
      phase: 'working',
      workerGeneration: 1,
      verificationAttempt: 0,
    }),
  };
}

describe('normalizeWebhooks', () => {
  it('normalizes string[] to WebhookConfig[] (backward compat)', () => {
    const configs = normalizeWebhooks(['https://a.com', 'https://b.com']);
    expect(configs.length).toBe(2);
    expect(configs[0].url).toBe('https://a.com');
    expect(configs[0].events).toBeUndefined();
    expect(configs[0].secret).toBeUndefined();
  });

  it('passes WebhookConfig[] through as-is', () => {
    const configs = normalizeWebhooks([
      { url: 'https://a.com', events: ['run.completed'], secret: 's' },
    ]);
    expect(configs.length).toBe(1);
    expect(configs[0].events).toEqual(['run.completed']);
    expect(configs[0].secret).toBe('s');
  });

  it('returns [] for undefined/empty', () => {
    expect(normalizeWebhooks(undefined)).toEqual([]);
    expect(normalizeWebhooks([])).toEqual([]);
  });
});

describe('HMAC signing', () => {
  const secret = 'my-webhook-secret';
  const body = JSON.stringify({ event: 'run.started', runId: 'abc' });

  it('signs a payload with sha256= prefix', () => {
    const sig = signPayload(secret, body);
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('produces different signatures for different secrets', () => {
    const sig1 = signPayload('secret1', body);
    const sig2 = signPayload('secret2', body);
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different bodies', () => {
    const sig1 = signPayload(secret, '{"a":1}');
    const sig2 = signPayload(secret, '{"a":2}');
    expect(sig1).not.toBe(sig2);
  });

  it('verifySignature accepts a valid signature', () => {
    const sig = signPayload(secret, body);
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it('verifySignature rejects a wrong secret', () => {
    const sig = signPayload(secret, body);
    expect(verifySignature('wrong-secret', body, sig)).toBe(false);
  });

  it('verifySignature rejects a tampered body', () => {
    const sig = signPayload(secret, body);
    expect(verifySignature(secret, '{"event":"run.failed"}', sig)).toBe(false);
  });

  it('verifySignature rejects missing/malformed signatures', () => {
    expect(verifySignature(secret, body, null)).toBe(false);
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, '')).toBe(false);
    expect(verifySignature(secret, body, 'not-sha256-prefixed')).toBe(false);
    expect(verifySignature(secret, body, 'sha256=tooshort')).toBe(false);
  });
});

describe('event filtering', () => {
  beforeEach(() => {
    clearDeliveryLog();
  });

  it('delivers all events when no events filter is set', async () => {
    const delivered: WebhookPayload[] = [];
    const notifier = createWebhookNotifier(
      [{ url: 'test://capture' }],
      silentLogger
    );
    // We can't easily intercept fetch in this test; instead verify via delivery log
    // that 'skipped' is NOT recorded when no filter is set.
    // Use a notifier that captures directly:
    const captureNotifier = async (payload: WebhookPayload) => {
      delivered.push(payload);
    };
    // The createWebhookNotifier uses fetch — for unit testing filtering logic,
    // we verify via the delivery log that skipped records appear only when filtering.
    await notifier(makePayload('run.started'));
    await new Promise((r) => setTimeout(r, 50));
    // No skipped records should exist (no filter)
    const log = getDeliveryLog();
    expect(log.filter((l) => l.result === 'skipped')).toHaveLength(0);
  });

  it('skips events not in the allowlist (records as skipped)', async () => {
    const notifier = createWebhookNotifier(
      [{ url: 'https://example.com/hook', events: ['run.completed', 'run.failed'] }],
      silentLogger
    );
    // 'run.started' is NOT in the allowlist → should be skipped
    await notifier(makePayload('run.started'));
    await new Promise((r) => setTimeout(r, 50));
    const log = getDeliveryLog();
    const skipped = log.filter((l) => l.result === 'skipped');
    expect(skipped.length).toBe(1);
    expect(skipped[0].event).toBe('run.started');
    expect(skipped[0].url).toBe('https://example.com/hook');
  });

  it('delivers events in the allowlist (not skipped)', async () => {
    clearDeliveryLog();
    const notifier = createWebhookNotifier(
      [{ url: 'http://127.0.0.1:1/hook', events: ['run.completed'] }],
      silentLogger
    );
    // 'run.completed' IS in the allowlist → should attempt delivery (will fail
    // because the URL is unreachable, but should NOT be 'skipped')
    await notifier(makePayload('run.completed'));
    // wait long enough for the retry (2s) + failure
    await new Promise((r) => setTimeout(r, 3000));
    const log = getDeliveryLog();
    const skipped = log.filter((l) => l.result === 'skipped' && l.event === 'run.completed');
    expect(skipped).toHaveLength(0);
    // There should be a delivery attempt (failed, since URL is unreachable)
    const attempts = log.filter((l) => l.event === 'run.completed' && l.result !== 'skipped');
    expect(attempts.length).toBe(1);
    expect(attempts[0].result).toBe('failed');
  });

  it('applies different filters to different webhooks', async () => {
    clearDeliveryLog();
    const notifier = createWebhookNotifier(
      [
        { url: 'https://a.com', events: ['run.completed'] },
        { url: 'https://b.com', events: ['run.failed'] },
      ],
      silentLogger
    );
    // 'run.started' should be skipped for BOTH
    await notifier(makePayload('run.started'));
    await new Promise((r) => setTimeout(r, 50));
    const log = getDeliveryLog();
    const skipped = log.filter((l) => l.result === 'skipped' && l.event === 'run.started');
    expect(skipped.length).toBe(2); // both webhooks skipped it
    const urls = skipped.map((s) => s.url).sort();
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('delivery log', () => {
  beforeEach(() => {
    clearDeliveryLog();
  });

  it('records skipped deliveries', async () => {
    const notifier = createWebhookNotifier(
      [{ url: 'https://x.com', events: ['run.completed'] }],
      silentLogger
    );
    await notifier(makePayload('run.stopped'));
    await new Promise((r) => setTimeout(r, 50));
    const log = getDeliveryLog();
    expect(log.length).toBe(1);
    expect(log[0].result).toBe('skipped');
    expect(log[0].event).toBe('run.stopped');
  });

  it('records failed deliveries (unreachable URL)', async () => {
    clearDeliveryLog();
    const notifier = createWebhookNotifier(
      [{ url: 'http://127.0.0.1:1/nonexistent' }],
      silentLogger
    );
    await notifier(makePayload('run.started', 'run-fail-test'));
    await new Promise((r) => setTimeout(r, 3000));
    const log = getDeliveryLog(100, 'run-fail-test');
    const failed = log.filter((l) => l.result === 'failed');
    expect(failed.length).toBe(1);
    expect(failed[0].error).toBeDefined();
    expect(failed[0].attempt).toBe(2);
  });

  it('filters by runId', async () => {
    const notifier = createWebhookNotifier(
      [{ url: 'https://x.com', events: ['run.completed'] }],
      silentLogger
    );
    await notifier(makePayload('run.stopped', 'run-A'));
    await notifier(makePayload('run.stopped', 'run-B'));
    await new Promise((r) => setTimeout(r, 50));
    const logA = getDeliveryLog(100, 'run-A');
    const logB = getDeliveryLog(100, 'run-B');
    expect(logA.length).toBe(1);
    expect(logB.length).toBe(1);
    expect(logA[0].runId).toBe('run-A');
  });

  it('caps the log at 500 records', async () => {
    const notifier = createWebhookNotifier(
      [{ url: 'https://x.com', events: ['run.completed'] }],
      silentLogger
    );
    // emit 510 skipped events
    for (let i = 0; i < 510; i++) {
      await notifier(makePayload('run.stopped', `run-${i}`));
    }
    await new Promise((r) => setTimeout(r, 100));
    const log = getDeliveryLog(1000);
    expect(log.length).toBe(500); // capped
  });

  it('clearDeliveryLog empties the log', async () => {
    const notifier = createWebhookNotifier(
      [{ url: 'https://x.com', events: ['run.completed'] }],
      silentLogger
    );
    await notifier(makePayload('run.stopped'));
    await new Promise((r) => setTimeout(r, 50));
    expect(getDeliveryLog().length).toBe(1);
    clearDeliveryLog();
    expect(getDeliveryLog().length).toBe(0);
  });

  it('records whether the delivery was signed', async () => {
    const notifier = createWebhookNotifier(
      [{ url: 'https://x.com', events: ['run.completed'], secret: 's3cret' }],
      silentLogger
    );
    await notifier(makePayload('run.stopped')); // skipped, but still records signed=true
    await new Promise((r) => setTimeout(r, 50));
    const log = getDeliveryLog();
    expect(log[0].signed).toBe(true);
  });
});
