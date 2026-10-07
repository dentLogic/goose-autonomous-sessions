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
  // ── v0.4: multi-policy rollover tracking ────────────────────────────────
  /** Number of completed worker turns in the CURRENT session. Resets on rollover. */
  turnsInCurrentSession?: number;
  /** ISO timestamp when the current session became active. Resets on rollover. */
  currentSessionStartedAt?: string;
  /** Why rollover is pending (which policy tripped). Cleared after rollover. */
  rolloverReason?: RolloverReason;
  // ── v0.5: cost tracking ───────────────────────────────────────────────────
  /** Estimated token cost (in cents) accumulated in the CURRENT session. Resets on rollover. */
  sessionCostCents?: number;
  /** Total estimated token cost (in cents) across the ENTIRE run. Never resets. */
  totalCostCents?: number;
  /** v0.5: The phase before the run was stopped, so resumeRun can restore it. */
  phaseBeforeStop?: AutonomousPhase;
}

// ── v0.4: configurable rollover policy ────────────────────────────────────────
//
// v0.1–v0.3 supported only context-percentage rollover. v0.4 adds optional
// turn-count and time-based policies. v0.5 adds cost-based. All enabled
// policies are combined with OR semantics — any one tripping marks rollover
// pending.
//
// A policy field is "enabled" when it is a positive number. Zero / undefined
// means the policy is disabled.

export type RolloverReason = 'context' | 'turns' | 'time' | 'cost';

export interface RolloverPolicy {
  /**
   * Context ratio at which rollover is marked pending.
   * 0..1. Default 0.75. Set to 0 to disable context-based rollover.
   * (This is the v0.1–v0.3 behavior, preserved as `rolloverThreshold` on
   * AutonomousSettings for backward compatibility.)
   */
  contextPercent?: number;
  /** Max worker turns per session before rollover. 0/undefined = disabled. */
  maxTurnsPerSession?: number;
  /** Max minutes per session before rollover. 0/undefined = disabled. */
  maxMinutesPerSession?: number;
  /**
   * v0.5: Max estimated token cost (in cents) per session before rollover.
   * 0/undefined = disabled. The controller tracks sessionCostCents on the run;
   * the host reports cost via onTurnFinished's AgentTurn.
   */
  maxCostCentsPerSession?: number;
}

export interface AutonomousSettings {
  enabled: boolean;
  rolloverThreshold: number; // 0..1, default 0.75 (v0.1–v0.3, preserved)
  // ── v0.4 ────────────────────────────────────────────────────────────────
  /**
   * Maximum verification attempts before the run enters an error state.
   * 0/undefined = unlimited (v0.1–v0.3 behavior).
   * A safety valve against infinite verify→fail→worker loops.
   */
  maxVerificationAttempts?: number;
  /**
   * Multi-policy rollover. The `contextPercent` here overrides
   * `rolloverThreshold` if both are set (this is the v0.4 canonical field).
   * For backward compat, if `rolloverPolicy` is omitted, the controller uses
   * `rolloverThreshold` for context-based rollover only.
   */
  rolloverPolicy?: RolloverPolicy;
  // ── v0.6 ────────────────────────────────────────────────────────────────
  /**
   * Maximum total token cost (in cents) for the ENTIRE run.
   * When totalCostCents >= maxTotalCostCents, the run enters an error state.
   * 0/undefined = unlimited (v0.1–v0.5 behavior).
   * Distinct from rolloverPolicy.maxCostCentsPerSession (which is per-session
   * and triggers rollover, not halt). This is a hard run-wide budget.
   */
  maxTotalCostCents?: number;
  /**
   * v0.6: Webhook URLs to notify on run events.
   * v0.7: can be either string[] (backward compat — all events, no signature)
   * OR WebhookConfig[] (with per-webhook event filtering + HMAC secret).
   */
  webhooks?: string[] | WebhookConfig[];
}

// ── v0.7: webhook configuration ───────────────────────────────────────────────

/**
 * A single webhook destination with optional event filtering + HMAC signing.
 *
 * - `url`: the endpoint to POST to
 * - `events`: optional allowlist of event types. If omitted, ALL events are sent.
 * - `secret`: if set, the payload is HMAC-SHA256 signed and the signature is
 *   sent in the `X-Goose-Autonomous-Signature` header. Receivers verify with:
 *     `crypto.timingSafeEqual(signature, hmacSha256(secret, body))`
 */
export interface WebhookConfig {
  url: string;
  /** Optional: only deliver these event types. Omit for ALL events. */
  events?: WebhookEvent[];
  /**
   * Optional: HMAC-SHA256 secret for payload signing. When set, the delivery
   * includes an `X-Goose-Autonomous-Signature: sha256=<hex>` header.
   */
  secret?: string;
}

// ── v0.6: webhook event types ────────────────────────────────────────────────

export type WebhookEvent =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.stopped'
  | 'run.resumed'
  | 'rollover.completed'
  | 'verification.started'
  | 'verification.passed'
  | 'verification.failed'
  | 'budget.exhausted';

export interface WebhookPayload {
  event: WebhookEvent;
  runId: string;
  /** ISO timestamp when the webhook was emitted. */
  emittedAt: string;
  /** The current run state (compact snapshot). */
  run: {
    status: AutonomousRunStatus;
    phase: AutonomousPhase;
    workerGeneration: number;
    verificationAttempt: number;
    totalCostCents?: number;
    sessionCostCents?: number;
    lastError?: string;
  };
  /** Event-specific details (e.g., rollover reason, verifier findings). */
  details?: Record<string, unknown>;
}

// ── v0.7: webhook delivery log ──────────────────────────────────────────────

/**
 * A record of a single webhook delivery attempt. Stored in-memory (capped)
 * for debugging — "did the webhook fire? did it succeed?".
 */
export interface WebhookDeliveryRecord {
  id: string;
  /** The webhook URL the delivery was attempted to. */
  url: string;
  /** The event type being delivered. */
  event: WebhookEvent;
  /** The runId the event is about. */
  runId: string;
  /** When the delivery attempt started. */
  attemptedAt: string;
  /** HTTP status code returned (undefined if network failure). */
  status?: number;
  /** 'delivered' | 'failed' | 'skipped' (skipped = filtered out by events). */
  result: 'delivered' | 'failed' | 'skipped';
  /** Error message on failure. */
  error?: string;
  /** Whether the payload was HMAC-signed. */
  signed: boolean;
  /** Attempt number (1 = first try, 2 = retry). */
  attempt: number;
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
  /** v0.5: estimated token cost for THIS turn, in cents. Optional. */
  costCents?: number;
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
