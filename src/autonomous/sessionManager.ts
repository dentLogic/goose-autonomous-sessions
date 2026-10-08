// src/lib/autonomous/sessionManager.ts
// Spec sections 27, 28, 29, 30, 39.
// In Goose Desktop this would call ACP session/new + session/prompt.
// Here it generates a fresh session id and persists lineage metadata.
import type { Handoff, SessionRole, StateStoreAdapter } from './types';

/** UUID generator — works in both Node.js and browser. */
function uuid(): string {
  const g = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface CreatedSession {
  sessionId: string;
  role: SessionRole;
  generation: number;
  name: string;
}

export function formatSessionName(role: SessionRole, generation: number): string {
  const pad = String(generation).padStart(2, '0');
  return role === 'worker' ? `[Auto] Worker ${pad}` : `[Auto] Verification ${pad}`;
}

/**
 * Create a completely fresh session. Spec 27: the previous session id must
 * NOT be supplied as a history source.
 */
export async function createFreshSession(
  store: StateStoreAdapter,
  input: {
    runId: string;
    role: SessionRole;
    generation: number;
    parentSessionId?: string;
    objective: string;
    handoff?: Handoff;
    sessionId?: string; // explicit id (used for the initial user session)
  }
): Promise<CreatedSession> {
  const sessionId = input.sessionId ?? `s-${uuid()}`;
  const name = formatSessionName(input.role, input.generation);
  await store.recordSession({
    sessionId,
    runId: input.runId,
    role: input.role,
    generation: input.generation,
    parentSessionId: input.parentSessionId,
    name,
    objective: input.objective,
    handoffJson: input.handoff ? JSON.stringify(input.handoff) : undefined,
  });
  return { sessionId, role: input.role, generation: input.generation, name };
}
