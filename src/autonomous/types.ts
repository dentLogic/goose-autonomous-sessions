// src/lib/autonomous/types.ts
// Core data model for goose-autonomous-sessions.
// Mirrors the implementation spec sections 4, 5, 6.

export type AutonomousPhase =
  | 'working'
  | 'handoff'
  | 'creating-session'
  | 'verifying'
  | 'completed'
  | 'stopped'
  | 'error';

export type AutonomousRunStatus = 'active' | 'completed' | 'stopped' | 'error';

export type AutonomousPromptOrigin =
  | 'user'
  | 'continuation'
  | 'verification'
  | 'handoff';

export type SessionRole = 'worker' | 'verification';

export type WorkerStatus = 'complete' | 'continue' | 'unknown';
export type VerificationStatus = 'pass' | 'fail' | 'unknown';

export type TransitionStage =
  | 'handoff-saved'
  | 'session-created'
  | 'prompt-sent'
  | 'session-active';

export interface HandoffTest {
  command?: string;
  result: string; // PASS | FAIL | UNKNOWN
  details?: string;
}

export interface Handoff {
  objective: string;
  currentState: string;
  completedWork: string[];
  remainingWork: string[];
  filesChanged: string[];
  tests: HandoffTest[];
  failures: string[];
  decisions: string[];
  constraints: string[];
  nextAction: string;
  generatedAt: string;
}

export interface AutonomousRun {
  schemaVersion: number;
  runId: string;
  status: AutonomousRunStatus;
  phase: AutonomousPhase;
  originalObjective: string;
  currentSessionId: string;
  previousSessionId?: string;
  pendingSessionId?: string;
  rolloverPending: boolean;
  contextUsage?: number;
  contextLimit?: number;
  rolloverThreshold: number;
  workerGeneration: number;
  verificationAttempt: number;
  transitionId?: string;
  transitionStage?: TransitionStage;
  handoff?: Handoff;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomousSettings {
  enabled: boolean;
  rolloverThreshold: number; // 0..1, default 0.75
}

export interface AutonomousOperation {
  type: 'continuation' | 'verification' | 'handoff';
  runId: string;
  sessionId: string;
}

export interface SessionRecord {
  sessionId: string;
  runId: string;
  role: SessionRole;
  generation: number;
  parentSessionId?: string;
  name: string;
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  objective: string;
  handoffJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LogEntry {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  runId?: string;
  message: string;
}

// Compact transcript line for the simulation's virtual agent turn.
export interface AgentTurn {
  sessionId: string;
  turnIndex: number;
  role: 'worker' | 'verification';
  summary: string;
  filesTouched: string[];
  testsRun: HandoffTest[];
  contextBefore: number;
  contextAfter: number;
  statusMarker?: WorkerStatus | VerificationStatus;
  ts: string;
}

// ---------------------------------------------------------------------------
// Adapter interfaces — the persistence/logging seams.
//
// The portable autonomous module depends ONLY on these interfaces. Concrete
// implementations are supplied by the host:
//   - Goose Desktop  -> Electron main-process adapter (app-data JSON file)
//   - Next.js demo   -> Prisma/SQLite adapter (src/lib/autonomous/stateStore.ts)
//   - standalone     -> in-memory adapter (examples/in-memory-adapters.ts)
//
// This is what makes the module drop into any host without modification.
// ---------------------------------------------------------------------------

export interface StateStoreAdapter {
  getRun(): Promise<AutonomousRun | null>;
  saveRun(run: AutonomousRun): Promise<void>;
  clearRun(): Promise<void>;
  getSettings(): Promise<AutonomousSettings>;
  saveSettings(settings: AutonomousSettings): Promise<void>;
  recordSession(input: {
    sessionId: string;
    runId: string;
    role: SessionRole;
    generation: number;
    parentSessionId?: string;
    name: string;
    objective: string;
    handoffJson?: string;
  }): Promise<void>;
  updateSessionStatus(
    sessionId: string,
    status: 'active' | 'completed' | 'failed' | 'abandoned'
  ): Promise<void>;
  getSessions(runId?: string): Promise<SessionRecord[]>;
  clearSessions(runId?: string): Promise<void>;
}

export interface LoggerAdapter {
  info(message: string, runId?: string): Promise<void>;
  warn(message: string, runId?: string): Promise<void>;
  error(message: string, runId?: string): Promise<void>;
}
