// src/autonomous/webhooks.ts
//
// v0.7 — webhook notification system with HMAC signing, event filtering,
// and a delivery log for debugging.
//
// Upgrades from v0.6:
//   - WebhookConfig supports per-webhook event allowlists (events?: WebhookEvent[])
//   - WebhookConfig supports HMAC-SHA256 payload signing (secret?: string)
//   - Delivery attempts are recorded in a capped in-memory log
//   - Receivers verify with: X-Goose-Autonomous-Signature header
//
// Backward compatible: string[] webhooks (v0.6) are normalized to WebhookConfig[]
// with no events filter + no secret.
import { createHmac, randomUUID } from 'crypto';
import type {
  LoggerAdapter,
  WebhookConfig,
  WebhookDeliveryRecord,
  WebhookEvent,
  WebhookPayload,
} from './types';

export type WebhookNotifier = (payload: WebhookPayload) => Promise<void>;

/** Cap on the in-memory delivery log (most recent kept). */
const MAX_DELIVERY_RECORDS = 500;

/**
 * Normalize the webhooks setting (string[] | WebhookConfig[]) to WebhookConfig[].
 * v0.6 string URLs become { url, events: undefined, secret: undefined }.
 */
export function normalizeWebhooks(
  webhooks: string[] | WebhookConfig[] | undefined
): WebhookConfig[] {
  if (!webhooks || webhooks.length === 0) return [];
  return webhooks.map((w) =>
    typeof w === 'string' ? { url: w } : w
  );
}

/**
 * Build a webhook notifier that POSTs JSON to each configured URL.
 * Supports per-URL event filtering + HMAC signing.
 * Records every delivery attempt in the delivery log.
 */
export function createWebhookNotifier(
  webhooks: string[] | WebhookConfig[] | undefined,
  logger: LoggerAdapter
): WebhookNotifier {
  const configs = normalizeWebhooks(webhooks);
  if (configs.length === 0) {
    return async () => {}; // no-op
  }

  return async (payload: WebhookPayload) => {
    for (const config of configs) {
      // v0.7: event filtering — skip if this event isn't in the allowlist
      if (config.events && config.events.length > 0 && !config.events.includes(payload.event)) {
        recordDelivery({
          url: config.url,
          event: payload.event,
          runId: payload.runId,
          result: 'skipped',
          signed: !!config.secret,
          attempt: 1,
        });
        continue; // don't deliver, don't retry
      }
      // fire-and-forget — don't block the controller
      deliverWithRetry(config, payload, logger).catch(() => {
        // errors are logged inside deliverWithRetry
      });
    }
  };
}

/**
 * Compute the HMAC-SHA256 signature for a payload body.
 * Returns the hex digest prefixed with "sha256=".
 */
export function signPayload(secret: string, body: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Verify a webhook signature (receiver-side helper).
 * Uses timingSafeEqual to prevent timing attacks.
 *
 * Example (on the receiving end):
 *   import { verifySignature } from 'goose-autonomous-sessions';
 *   const body = await req.text();
 *   const sig = req.headers.get('X-Goose-Autonomous-Signature');
 *   if (!verifySignature(SECRET, body, sig)) {
 *     return res.status(401).json({ error: 'Invalid signature' });
 *   }
 */
export function verifySignature(secret: string, body: string, signature: string | null | undefined): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = signPayload(secret, body);
  // timing-safe compare
  if (expected.length !== signature.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && a.equals(b) && timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  // Both are the same length here (checked above).
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function deliverWithRetry(
  config: WebhookConfig,
  payload: WebhookPayload,
  logger: LoggerAdapter,
  attempt = 1
): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  // v0.7: HMAC signing
  if (config.secret) {
    headers['X-Goose-Autonomous-Signature'] = signPayload(config.secret, body);
  }

  // v0.8: resolve the retry policy
  const policy = config.retry ?? {};
  const maxAttempts = policy.maxAttempts ?? 2;
  const backoffMs = policy.backoffMs ?? 2000;
  const strategy = policy.backoffStrategy ?? 'fixed';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok && res.status >= 400) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    await logger.info(
      `webhook delivered: ${payload.event} → ${config.url} (${res.status})`,
      payload.runId
    );
    recordDelivery({
      url: config.url,
      event: payload.event,
      runId: payload.runId,
      status: res.status,
      result: 'delivered',
      signed: !!config.secret,
      attempt,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (attempt < maxAttempts) {
      // v0.8: compute backoff (fixed or exponential)
      let delay = strategy === 'exponential'
        ? backoffMs * Math.pow(2, attempt - 1)
        : backoffMs;
      // v0.9: apply jitter (random 0–50% of the delay) to avoid thundering-herd
      if (policy.jitter) {
        delay = delay + Math.random() * (delay * 0.5);
      }
      await new Promise((r) => setTimeout(r, delay));
      await deliverWithRetry(config, payload, logger, attempt + 1);
    } else {
      await logger.warn(
        `webhook delivery failed (${maxAttempts} attempts): ${config.url} — ${msg}`,
        payload.runId
      );
      recordDelivery({
        url: config.url,
        event: payload.event,
        runId: payload.runId,
        result: 'failed',
        error: msg,
        signed: !!config.secret,
        attempt,
        // v0.9: store payload + config for replay
        payload,
        config: { url: config.url, secret: config.secret, retry: config.retry },
      });
    }
  }
}

// ── delivery log ───────────────────────────────────────────────────────────────

const deliveryLog: WebhookDeliveryRecord[] = [];

function recordDelivery(input: {
  url: string;
  event: WebhookEvent;
  runId: string;
  status?: number;
  result: 'delivered' | 'failed' | 'skipped';
  error?: string;
  signed: boolean;
  attempt: number;
  payload?: WebhookPayload;
  config?: { url: string; secret?: string; retry?: any };
}): void {
  deliveryLog.push({
    id: randomUUID(),
    url: input.url,
    event: input.event,
    runId: input.runId,
    attemptedAt: new Date().toISOString(),
    status: input.status,
    result: input.result,
    error: input.error,
    signed: input.signed,
    attempt: input.attempt,
    // v0.9: store for replay (only on failed deliveries)
    payload: input.payload,
    config: input.config,
  });
  // cap the log
  if (deliveryLog.length > MAX_DELIVERY_RECORDS) {
    deliveryLog.splice(0, deliveryLog.length - MAX_DELIVERY_RECORDS);
  }
}

/** Get the delivery log (most recent first). For the dashboard / debugging. */
export function getDeliveryLog(limit = 100, runId?: string): WebhookDeliveryRecord[] {
  let logs = [...deliveryLog].reverse(); // newest first
  if (runId) logs = logs.filter((l) => l.runId === runId);
  return logs.slice(0, limit);
}

/** Clear the delivery log (for tests / reset). */
export function clearDeliveryLog(): void {
  deliveryLog.length = 0;
}

/** Build a compact run snapshot for a webhook payload. */
export function buildRunSnapshot(run: {
  status: string;
  phase: string;
  workerGeneration: number;
  verificationAttempt: number;
  totalCostCents?: number;
  sessionCostCents?: number;
  lastError?: string;
}) {
  return {
    status: run.status as 'active' | 'completed' | 'stopped' | 'error',
    phase: run.phase as 'working' | 'handoff' | 'creating-session' | 'verifying' | 'completed' | 'stopped' | 'error',
    workerGeneration: run.workerGeneration,
    verificationAttempt: run.verificationAttempt,
    totalCostCents: run.totalCostCents,
    sessionCostCents: run.sessionCostCents,
    lastError: run.lastError,
  };
}

// ── v0.9: webhook event replay ───────────────────────────────────────────────

/**
 * v0.9: Re-deliver failed webhook deliveries.
 *
 * Finds all records with `result: 'failed'` that have a stored payload + config,
 * and re-attempts delivery. Useful when a webhook endpoint was temporarily down
 * and you want to re-deliver the events that couldn't be delivered.
 *
 * @param logger — the logger to use for delivery logging
 * @param runId — optional: only replay failures for this run
 * @returns the number of deliveries re-attempted
 *
 * The original delivery records are NOT removed — new records are appended
 * for the replay attempts (so you can see the full delivery history).
 */
export async function replayFailedDeliveries(
  logger: LoggerAdapter,
  runId?: string
): Promise<number> {
  const failed = deliveryLog.filter(
    (r) => r.result === 'failed' && r.payload && r.config
  );
  const toReplay = runId ? failed.filter((r) => r.runId === runId) : failed;
  for (const record of toReplay) {
    // Re-attempt delivery with the original config + payload.
    // Use maxAttempts=1 so replay doesn't trigger another retry cycle.
    const config: WebhookConfig = {
      url: record.config!.url,
      secret: record.config!.secret,
      retry: { maxAttempts: 1, backoffMs: 0 },
    };
    await deliverWithRetry(config, record.payload!, logger, 1);
  }
  return toReplay.length;
}

/**
 * v0.9: Get failed delivery records that are eligible for replay
 * (have a stored payload + config).
 */
export function getReplayableDeliveries(runId?: string): WebhookDeliveryRecord[] {
  return deliveryLog.filter(
    (r) => r.result === 'failed' && r.payload && r.config && (!runId || r.runId === runId)
  );
}
