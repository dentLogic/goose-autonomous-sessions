// src/autonomous/logger.ts
// Spec sections 31, 45, 46. Compact local event log with rotation.
//
// NOTE: The Prisma client is imported LAZILY so this module loads without
// Prisma installed. Use prismaLogger only in hosts with Prisma configured.
import { MAX_LOG_ROWS } from './constants';
import type { LogEntry, LoggerAdapter } from './types';

/** Lazy Prisma loader — throws if Prisma isn't configured. */
async function getDb(): Promise<any> {
  try {
    const mod = await import('@/lib/db');
    return mod.db;
  } catch {
    throw new Error(
      'Prisma is not configured. This logger is a reference adapter — ' +
      'use it only in hosts with Prisma. For standalone use, inject your own ' +
      'LoggerAdapter (see examples/in-memory-adapters.ts).'
    );
  }
}

export async function appendLog(
  level: LogEntry['level'],
  message: string,
  runId?: string
): Promise<void> {
  try {
    const db = await getDb();
    await db.autonomousLogRow.create({
      data: { level, message, runId },
    });
    // rotation: cap total rows
    const total = await db.autonomousLogRow.count();
    if (total > MAX_LOG_ROWS) {
      const overflow = total - MAX_LOG_ROWS;
      const oldest = await db.autonomousLogRow.findMany({
        orderBy: { ts: 'asc' },
        take: overflow,
        select: { id: true },
      });
      if (oldest.length) {
        await db.autonomousLogRow.deleteMany({
          where: { id: { in: oldest.map((r) => r.id) } },
        });
      }
    }
  } catch (e) {
    // logging must never break the controller
    if (!(e instanceof Error && e.message.includes('Prisma is not configured'))) {
      console.error('[autonomous.logger] failed to append log', e);
    }
  }
}

export const log = {
  info: (msg: string, runId?: string) => appendLog('info', msg, runId),
  warn: (msg: string, runId?: string) => appendLog('warn', msg, runId),
  error: (msg: string, runId?: string) => appendLog('error', msg, runId),
};

// Adapter object implementing LoggerAdapter — the Prisma/SQLite reference
// implementation. Pass this to AutonomousSessionController in Next.js hosts.
export const prismaLogger: LoggerAdapter = {
  info: (msg, runId) => appendLog('info', msg, runId),
  warn: (msg, runId) => appendLog('warn', msg, runId),
  error: (msg, runId) => appendLog('error', msg, runId),
};

export async function getLogs(limit = 200, runId?: string): Promise<LogEntry[]> {
  const db = await getDb();
  const rows = await db.autonomousLogRow.findMany({
    where: runId ? { runId } : undefined,
    orderBy: { ts: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts.toISOString(),
    level: r.level as LogEntry['level'],
    runId: r.runId ?? undefined,
    message: r.message,
  }));
}

export async function clearLogs(): Promise<void> {
  const db = await getDb();
  await db.autonomousLogRow.deleteMany({});
}
