// examples/in-memory-adapters.ts
//
// In-memory implementations of StateStoreAdapter + LoggerAdapter.
// Used by examples/standalone-demo.ts so the demo runs with ZERO external
// dependencies (no database, no Electron, no Next.js).
//
// In a real Goose Desktop build you would write an Electron main-process
// adapter that persists to a JSON file in app-data instead.
import type {
  AutonomousRun,
  AutonomousSettings,
  LoggerAdapter,
  SessionRecord,
  StateStoreAdapter,
} from '../src/autonomous/types';

const mem: {
  run: AutonomousRun | null;
  settings: AutonomousSettings;
  sessions: SessionRecord[];
  logs: { id: string; ts: string; level: 'info' | 'warn' | 'error'; message: string; runId?: string }[];
} = {
  run: null,
  settings: { enabled: true, rolloverThreshold: 0.75 },
  sessions: [],
  logs: [],
};

let logCounter = 0;

export const inMemoryStore: StateStoreAdapter = {
  async getRun() {
    return mem.run;
  },
  async saveRun(run) {
    mem.run = { ...run };
  },
  async clearRun() {
    mem.run = null;
  },
  async getSettings() {
    return { ...mem.settings };
  },
  async saveSettings(s) {
    mem.settings = { ...s };
  },
  async recordSession(input) {
    const now = new Date().toISOString();
    mem.sessions.push({
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
  },
  async updateSessionStatus(sessionId, status) {
    const s = mem.sessions.find((x) => x.sessionId === sessionId);
    if (s) {
      s.status = status;
      s.updatedAt = new Date().toISOString();
    }
  },
  async getSessions(runId) {
    return runId
      ? mem.sessions.filter((s) => s.runId === runId).map((s) => ({ ...s }))
      : mem.sessions.map((s) => ({ ...s }));
  },
  async clearSessions(runId) {
    if (runId) {
      mem.sessions = mem.sessions.filter((s) => s.runId !== runId);
    } else {
      mem.sessions = [];
    }
  },
};

export const consoleLogger: LoggerAdapter = {
  async info(message, runId) {
    mem.logs.push({ id: `l${logCounter++}`, ts: new Date().toISOString(), level: 'info', message, runId });
    const tag = runId ? `[${runId.slice(0, 8)}] ` : '';
    console.log(`  \x1b[32m●\x1b[0m ${tag}${message}`);
  },
  async warn(message, runId) {
    mem.logs.push({ id: `l${logCounter++}`, ts: new Date().toISOString(), level: 'warn', message, runId });
    const tag = runId ? `[${runId.slice(0, 8)}] ` : '';
    console.log(`  \x1b[33m⚠\x1b[0m ${tag}${message}`);
  },
  async error(message, runId) {
    mem.logs.push({ id: `l${logCounter++}`, ts: new Date().toISOString(), level: 'error', message, runId });
    const tag = runId ? `[${runId.slice(0, 8)}] ` : '';
    console.log(`  \x1b[31m✗\x1b[0m ${tag}${message}`);
  },
};

export function getMemLogs() {
  return [...mem.logs];
}

export function getMemSessions() {
  return [...mem.sessions];
}
