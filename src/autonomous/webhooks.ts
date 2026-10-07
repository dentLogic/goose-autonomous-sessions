// src/autonomous/webhooks.ts
//
// v0.6 — webhook notification system.
//
// Delivers WebhookPayload POSTs to configured URLs on run events
// (completion, failure, rollover, verification, budget exhaustion).
//
// Design:
//   - Fire-and-forget (never blocks the controller state machine)
//   - Retries once on network failure (after 2s)
//   - 5s timeout per attempt
//   - Logs delivery success/failure via the injected LoggerAdapter
//   - Uses the global fetch (Node 18+ / Bun / browsers)
//
// The notifier is a strategy injected via ControllerDeps so hosts can swap it
// (e.g. for testing, or to use a queue instead of direct HTTP).
import type { LoggerAdapter, WebhookPayload } from './types';

export type WebhookNotifier = (payload: WebhookPayload) => Promise<void>;

/**
 * Build a webhook notifier that POSTs JSON to each URL in the settings.
 * Returns a no-op if no webhooks are configured.
 */
export function createWebhookNotifier(
  urls: string[] | undefined,
  logger: LoggerAdapter
): WebhookNotifier {
  if (!urls || urls.length === 0) {
    return async () => {}; // no-op
  }

  return async (payload: WebhookPayload) => {
    const body = JSON.stringify(payload);
    for (const url of urls) {
      // fire-and-forget — don't await in a way that blocks the controller
      deliverWithRetry(url, body, payload, logger).catch(() => {
        // errors are logged inside deliverWithRetry; swallow here
      });
    }
  };
}

async function deliverWithRetry(
  url: string,
  body: string,
  payload: WebhookPayload,
  logger: LoggerAdapter,
  attempt = 1
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok && res.status >= 400) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    await logger.info(
      `webhook delivered: ${payload.event} → ${url} (${res.status})`,
      payload.runId
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (attempt < 2) {
      // retry once after 2s
      await new Promise((r) => setTimeout(r, 2000));
      await deliverWithRetry(url, body, payload, logger, 2);
    } else {
      await logger.warn(
        `webhook delivery failed (2 attempts): ${url} — ${msg}`,
        payload.runId
      );
    }
  }
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
