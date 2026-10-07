// src/lib/autonomous/navigation.ts
// Spec sections 15, 30, 31.
// In Goose Desktop this would dispatch a browser event consumed by
// useNavigationSessions.ts. Here we emit a log entry via the injected logger.
import { NAV_EVENT_SWITCH_SESSION } from './constants';
import type { LoggerAdapter } from './types';

export interface SwitchSessionEvent {
  type: typeof NAV_EVENT_SWITCH_SESSION;
  sessionId: string;
  ts: string;
}

export async function navigateToSession(
  logger: LoggerAdapter,
  sessionId: string,
  runId?: string
): Promise<void> {
  await logger.info(`navigated to session ${sessionId}`, runId);
}
