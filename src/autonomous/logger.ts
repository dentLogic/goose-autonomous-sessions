// src/lib/autonomous/logger.ts
// Spec sections 31, 45, 46. Compact local event log with rotation.
import { db } from '@/lib/db';
import { MAX_LOG_ROWS } from './constants';
import type { LogEntry, LoggerAdapter } from './types';

export async function appendLog(
  level: LogEntry['level'],
  message: string,
  runId?: string
): Promise<void> {
  try {
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
    console.error('[autonomous.logger] failed to append log', e);
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
  await db.autonomousLogRow.deleteMany({});
}
