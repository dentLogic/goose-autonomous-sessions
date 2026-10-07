// src/autonomous/stateStore.ts
// Spec sections 7, 8, 9, 10, 11, 33, 37, 40, 62.
// Atomic persistence through Prisma transactions. In Goose Desktop this layer
// would be the Electron main process; here it is the Next.js server.
//
// NOTE: The Prisma client is imported LAZILY so this module loads without
// Prisma installed. The portable core (controller, types, handoff, etc.) has
// zero hard deps. This file is a reference adapter — only use it in hosts
// that have Prisma configured.
import { AUTONOMOUS_SCHEMA_VERSION, DEFAULT_SETTINGS } from './constants';
import type { AutonomousRun, AutonomousSettings, SessionRecord, StateStoreAdapter } from './types';

/** Lazy Prisma loader — throws if Prisma isn't configured. */
async function getDb(): Promise<any> {
  try {
    // Dynamic import so the module loads even without @/lib/db
    const mod = await import('@/lib/db');
    return mod.db;
  } catch {
    throw new Error(
      'Prisma is not configured. This stateStore is a reference adapter — ' +
      'use it only in hosts with Prisma. For standalone use, inject your own ' +
      'StateStoreAdapter (see examples/in-memory-adapters.ts).'
    );
  }
}

const RUN_KEY = 'active';
const SETTINGS_KEY = 'global';

export async function getRun(): Promise<AutonomousRun | null> {
  const db = await getDb();
  const row = await db.autonomousRunRow.findUnique({ where: { key: RUN_KEY } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data) as AutonomousRun;
    if (parsed.schemaVersion !== AUTONOMOUS_SCHEMA_VERSION) {
      // forward-compat hook; for now return as-is
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveRun(run: AutonomousRun): Promise<void> {
  const data = JSON.stringify(run);
  // upsert = atomic single-row write
  const db = await getDb();
  await db.autonomousRunRow.upsert({
    where: { key: RUN_KEY },
    create: { key: RUN_KEY, data },
    update: { data },
  });
}

export async function clearRun(): Promise<void> {
  const db = await getDb();
  await db.autonomousRunRow.deleteMany({ where: { key: RUN_KEY } });
}

export async function getSettings(): Promise<AutonomousSettings> {
  const db = await getDb();
  const row = await db.autonomousSettingsRow.findUnique({
    where: { key: SETTINGS_KEY },
  });
  if (!row) return { ...DEFAULT_SETTINGS };
  return { enabled: row.enabled, rolloverThreshold: row.threshold };
}

export async function saveSettings(s: AutonomousSettings): Promise<void> {
  const db = await getDb();
  await db.autonomousSettingsRow.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, enabled: s.enabled, threshold: s.rolloverThreshold },
    update: { enabled: s.enabled, threshold: s.rolloverThreshold },
  });
}

// ---- session lineage records (spec 30, 39) ----
export async function recordSession(input: {
  sessionId: string;
  runId: string;
  role: 'worker' | 'verification';
  generation: number;
  parentSessionId?: string;
  name: string;
  objective: string;
  handoffJson?: string;
}): Promise<void> {
  const db = await getDb();
  await db.autonomousSessionRow.create({
    data: {
      sessionId: input.sessionId,
      runId: input.runId,
      role: input.role,
      generation: input.generation,
      parentSessionId: input.parentSessionId,
      name: input.name,
      status: 'active',
      objective: input.objective,
      handoffJson: input.handoffJson,
    },
  });
}

export async function updateSessionStatus(
  sessionId: string,
  status: 'active' | 'completed' | 'failed' | 'abandoned'
): Promise<void> {
  const db = await getDb();
  await db.autonomousSessionRow.updateMany({
    where: { sessionId },
    data: { status },
  });
}

export async function getSessions(runId?: string): Promise<SessionRecord[]> {
  const db = await getDb();
  const rows = await db.autonomousSessionRow.findMany({
    where: runId ? { runId } : undefined,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    sessionId: r.sessionId,
    runId: r.runId,
    role: r.role as SessionRecord['role'],
    generation: r.generation,
    parentSessionId: r.parentSessionId ?? undefined,
    name: r.name,
    status: r.status as SessionRecord['status'],
    objective: r.objective,
    handoffJson: r.handoffJson ?? undefined,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function clearSessions(runId?: string): Promise<void> {
  const db = await getDb();
  await db.autonomousSessionRow.deleteMany({
    where: runId ? { runId } : undefined,
  });
}

// Adapter object implementing StateStoreAdapter — the Prisma/SQLite reference
// implementation. Pass this to AutonomousSessionController in Next.js hosts.
export const prismaStateStore: StateStoreAdapter = {
  getRun,
  saveRun,
  clearRun,
  getSettings,
  saveSettings,
  recordSession,
  updateSessionStatus,
  getSessions,
  clearSessions,
};
