// adapters/electron-state-store.ts
//
// StateStoreAdapter backed by the Electron main process.
//
// Persists the autonomous run record, settings, session lineage, and logs to
// JSON files in the Electron `userData` directory (e.g.
// ~/.config/Goose/ on Linux, ~/Library/Application Support/Goose/ on macOS).
//
// Atomic writes: write to a temp file, fsync, then rename — so a crash never
// leaves a half-written autonomous-state.json.
//
// Spec sections 7, 8, 9, 17, 18, 33, 37, 62.
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AutonomousRun,
  AutonomousSettings,
  SessionRecord,
  StateStoreAdapter,
} from '../src/autonomous/types';
import { AUTONOMOUS_SCHEMA_VERSION, DEFAULT_SETTINGS, MAX_LOG_ROWS } from '../src/autonomous/constants';

interface LogRow {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  runId?: string;
}

function dataDir(): string {
  // app.getPath('userData') is only available in the main process after
  // app.whenReady(). We resolve lazily so this module can be imported early.
  return app.getPath('userData');
}

function filePath(name: string): string {
  return path.join(dataDir(), name);
}

/** Atomic write: tmp → fsync → rename. Never leaves a half-written file. */
async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, contents, 'utf8');
  // fsync so the bytes are durable on disk before rename
  const handle = await fs.promises.open(tmp, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, file);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

const RUN_FILE = 'autonomous-state.json';
const SETTINGS_FILE = 'autonomous-settings.json';
const SESSIONS_FILE = 'autonomous-sessions.json';
const LOG_FILE = 'autonomous.log.jsonl';

interface SessionsFile {
  sessions: SessionRecord[];
}
interface LogsFile {
  logs: LogRow[];
}

/** In-process cache so reads are fast and writes are batched where safe. */
let cachedRun: AutonomousRun | null | undefined;
let cachedSettings: AutonomousSettings | undefined;
let cachedSessions: SessionRecord[] | undefined;
let logBuffer: LogRow[] = [];
let logFlushTimer: NodeJS.Timeout | null = null;

function scheduleLogFlush(): void {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(async () => {
    logFlushTimer = null;
    if (logBuffer.length === 0) return;
    const batch = logBuffer;
    logBuffer = [];
    try {
      const existing = await readJson<LogsFile>(filePath(LOG_FILE), { logs: [] });
      const merged = [...existing.logs, ...batch];
      // rotate: keep only the most recent MAX_LOG_ROWS
      const trimmed = merged.length > MAX_LOG_ROWS
        ? merged.slice(merged.length - MAX_LOG_ROWS)
        : merged;
      await atomicWrite(filePath(LOG_FILE), JSON.stringify({ logs: trimmed }));
    } catch {
      // never let logging break the controller
      console.error('[autonomous] failed to flush log batch');
    }
  }, 500);
}

export const electronStateStore: StateStoreAdapter = {
  async getRun() {
    if (cachedRun !== undefined) return cachedRun;
    const run = await readJson<AutonomousRun | null>(filePath(RUN_FILE), null);
    cachedRun = run;
    return run;
  },

  async saveRun(run) {
    const stamped: AutonomousRun = {
      ...run,
      schemaVersion: AUTONOMOUS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(filePath(RUN_FILE), JSON.stringify(stamped, null, 2));
    cachedRun = stamped;
  },

  async clearRun() {
    try {
      await fs.promises.unlink(filePath(RUN_FILE));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    cachedRun = null;
  },

  async getSettings() {
    if (cachedSettings) return cachedSettings;
    const s = await readJson<AutonomousSettings>(filePath(SETTINGS_FILE), {
      ...DEFAULT_SETTINGS,
    });
    cachedSettings = s;
    return s;
  },

  async saveSettings(s) {
    await atomicWrite(filePath(SETTINGS_FILE), JSON.stringify(s, null, 2));
    cachedSettings = { ...s };
  },

  async recordSession(input) {
    if (!cachedSessions) {
      const file = await readJson<SessionsFile>(filePath(SESSIONS_FILE), { sessions: [] });
      cachedSessions = file.sessions;
    }
    const now = new Date().toISOString();
    cachedSessions.push({
      sessionId: input.sessionId,
      runId: input.runId,
      role: input.role,
      generation: input.generation,
      parentSessionId: input.parentSessionId,
      name: input.name,
      status: 'active',
      objective: input.objective,
      handoffJson: input.handoffJson,
      createdAt: now,
      updatedAt: now,
    });
    await atomicWrite(filePath(SESSIONS_FILE), JSON.stringify({ sessions: cachedSessions }, null, 2));
  },

  async updateSessionStatus(sessionId, status) {
    if (!cachedSessions) return;
    const s = cachedSessions.find((x) => x.sessionId === sessionId);
    if (s) {
      s.status = status;
      s.updatedAt = new Date().toISOString();
      await atomicWrite(filePath(SESSIONS_FILE), JSON.stringify({ sessions: cachedSessions }, null, 2));
    }
  },

  async getSessions(runId) {
    if (!cachedSessions) {
      const file = await readJson<SessionsFile>(filePath(SESSIONS_FILE), { sessions: [] });
      cachedSessions = file.sessions;
    }
    const filtered = runId ? cachedSessions.filter((s) => s.runId === runId) : cachedSessions;
    return filtered.map((s) => ({ ...s }));
  },

  async clearSessions(runId) {
    if (!cachedSessions) {
      cachedSessions = [];
    } else if (runId) {
      cachedSessions = cachedSessions.filter((s) => s.runId !== runId);
    } else {
      cachedSessions = [];
    }
    await atomicWrite(filePath(SESSIONS_FILE), JSON.stringify({ sessions: cachedSessions }, null, 2));
  },
};

/** Append a log row (used by electronLogger below). Batched + rotated. */
export async function appendElectronLog(
  level: LogRow['level'],
  message: string,
  runId?: string
): Promise<void> {
  logBuffer.push({
    id: randomUUID(),
    ts: new Date().toISOString(),
    level,
    message,
    runId,
  });
  scheduleLogFlush();
}

/** Flush pending log entries immediately (used on app quit). */
export async function flushElectronLogs(): Promise<void> {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (logBuffer.length === 0) return;
  const batch = logBuffer;
  logBuffer = [];
  try {
    const existing = await readJson<LogsFile>(filePath(LOG_FILE), { logs: [] });
    const merged = [...existing.logs, ...batch];
    const trimmed = merged.length > MAX_LOG_ROWS
      ? merged.slice(merged.length - MAX_LOG_ROWS)
      : merged;
    await atomicWrite(filePath(LOG_FILE), JSON.stringify({ logs: trimmed }));
  } catch (e) {
    console.error('[autonomous] failed to flush logs on quit', e);
  }
}

/** Read the persisted logs (for the UI / diagnostics). */
export async function getElectronLogs(limit = 200, runId?: string): Promise<LogRow[]> {
  const file = await readJson<LogsFile>(filePath(LOG_FILE), { logs: [] });
  let logs = file.logs;
  if (runId) logs = logs.filter((l) => l.runId === runId);
  return logs.slice(-limit).reverse();
}

/** Clear all persisted autonomous state (for the uninstaller / "reset"). */
export async function clearAllElectronState(): Promise<void> {
  for (const f of [RUN_FILE, SETTINGS_FILE, SESSIONS_FILE, LOG_FILE]) {
    try {
      await fs.promises.unlink(filePath(f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  cachedRun = null;
  cachedSettings = undefined;
  cachedSessions = undefined;
  logBuffer = [];
}
