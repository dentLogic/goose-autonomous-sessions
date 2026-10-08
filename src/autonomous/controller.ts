// src/lib/autonomous/controller.ts
// Spec sections 12, 13, 14, 15, 19, 22, 28, 32, 33, 34, 35, 47, 49, 50, 57, 58, 59, 60.
//
// The controller has ZERO hard dependencies on any persistence layer or host
// runtime. State storage and logging are injected as adapters (StateStoreAdapter
// / LoggerAdapter), so the same controller class runs unchanged inside:
//   - Goose Desktop  (Electron main-process adapters)
//   - a Next.js app   (Prisma/SQLite adapters — see ./stateStore.ts + ./logger.ts)
//   - a standalone script (in-memory adapters — see examples/)
import { AUTONOMOUS_SCHEMA_VERSION, DEFAULT_CONTEXT_LIMIT } from './constants';
import { detectVerificationStatus, detectWorkerStatus } from './completionDetector';
import {
  buildHandoffPrompt,
  isValidHandoff,
  parseHandoffResponse,
  serializeHandoff,
  stampObjective,
} from './handoff';
import {
  buildHandoffPromptFromSchema,
  coerceToHandoff,
  defaultHandoffSchema,
  isValidHandoffAgainstSchema,
  parseHandoffResponseWithSchema,
  serializeHandoffWithSchema,
  type HandoffSchema,
} from './handoff-schema';
import { navigateToSession } from './navigation';
import {
  evaluateRollover,
  resolvePolicy,
  verificationBudgetExceeded,
} from './rollover-policy';
import { createFreshSession, formatSessionName } from './sessionManager';
import {
  buildRunSnapshot,
  createWebhookNotifier,
  type WebhookNotifier,
} from './webhooks';
import type {
  AgentTurn,
  AutonomousRun,
  AutonomousSettings,
  Handoff,
  LoggerAdapter,
  RolloverReason,
  StateStoreAdapter,
  WebhookEvent,
  WebhookPayload,
} from './types';

// ---- host-injected strategies ------------------------------------------------
// Spec 23: generateHandoff(sessionId, objective). The real impl sends a prompt
// into the current worker session. Here we delegate to an injected generator.
export type HandoffGenerator = (input: {
  sessionId: string;
  objective: string;
  prompt: string;
}) => Promise<string | null>;

export type ContinuationPromptSender = (input: {
  sessionId: string;
  prompt: string;
  origin: 'continuation' | 'verification';
}) => Promise<void>;

export interface ControllerDeps {
  /** Persistence seam — see StateStoreAdapter. */
  store: StateStoreAdapter;
  /** Logging seam — see LoggerAdapter. */
  logger: LoggerAdapter;
  /** Ask the current worker session to produce a structured handoff (JSON). */
  generateHandoffResponse: HandoffGenerator;
  /** Submit a prompt into a (fresh) ACP session. */
  sendPrompt: ContinuationPromptSender;
  /**
   * Optional custom handoff schema (v0.3). If omitted, the default 9-field
   * schema is used (backward compatible with v0.1/v0.2).
   */
  handoffSchema?: HandoffSchema;
  /**
   * Optional settings override (v0.4). When set, the controller uses these
   * settings (verification budget + rollover policy) instead of the settings
   * supplied at startRun time. Useful for hosts that want to change settings
   * mid-run without restarting.
   */
  settings?: AutonomousSettings;
  /**
   * v0.6: optional webhook notifier override. If omitted, the controller
   * builds one from settings.webhooks via createWebhookNotifier().
   */
  webhookNotifier?: WebhookNotifier;
}

const nowISO = () => new Date().toISOString();

/** UUID generator — works in both Node.js and browser (no top-level crypto import). */
function uuid(): string {
  const g = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function freshRun(input: {
  objective: string;
  sessionId: string;
  threshold: number;
}): AutonomousRun {
  const ts = nowISO();
  return {
    schemaVersion: AUTONOMOUS_SCHEMA_VERSION,
    runId: uuid(),
    status: 'active',
    phase: 'working',
    originalObjective: input.objective,
    currentSessionId: input.sessionId,
    rolloverPending: false,
    contextUsage: 0,
    contextLimit: DEFAULT_CONTEXT_LIMIT,
    rolloverThreshold: input.threshold,
    workerGeneration: 1,
    verificationAttempt: 0,
    createdAt: ts,
    updatedAt: ts,
    // v0.4: multi-policy rollover tracking
    turnsInCurrentSession: 0,
    currentSessionStartedAt: ts,
    rolloverReason: undefined,
    // v0.5: cost tracking
    sessionCostCents: 0,
    totalCostCents: 0,
  };
}

// ---- public API -------------------------------------------------------------

export class AutonomousSessionController {
  // Spec 47: serialized transition queue to prevent double-rollover.
  private transitionPromise: Promise<void> = Promise.resolve();
  /** Exposed so recovery.ts can reuse the same adapters. */
  readonly store: StateStoreAdapter;
  readonly logger: LoggerAdapter;
  /** The active handoff schema (custom or default). */
  readonly handoffSchema: HandoffSchema;
  /** v0.6: the webhook notifier (no-op if no webhooks configured). */
  private webhookNotifier: WebhookNotifier;

  constructor(private deps: ControllerDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
    this.handoffSchema = deps.handoffSchema ?? defaultHandoffSchema();
    // v0.6: resolve the webhook notifier — explicit override, or build from settings
    this.webhookNotifier = deps.webhookNotifier ?? createWebhookNotifier([], this.logger);
  }

  /** v0.4: resolve the effective settings (deps.settings override > run-time settings). */
  private effectiveSettings(runSettings: AutonomousSettings): AutonomousSettings {
    return this.deps.settings ?? runSettings;
  }

  /** v0.6: emit a webhook event. Fire-and-forget. */
  private emitWebhook(event: WebhookEvent, run: AutonomousRun, details?: Record<string, unknown>): void {
    const settings = this.effectiveSettings({
      enabled: true,
      rolloverThreshold: run.rolloverThreshold,
    });
    // Re-resolve the notifier if settings changed (webhooks may be set per-run)
    const notifier = this.deps.webhookNotifier
      ?? createWebhookNotifier(settings.webhooks, this.logger);
    const payload: WebhookPayload = {
      event,
      runId: run.runId,
      emittedAt: nowISO(),
      run: buildRunSnapshot(run),
      details,
    };
    // fire-and-forget — never block the state machine
    notifier(payload).catch(() => {
      // errors are logged inside the notifier
    });
  }

  /**
   * v0.6: check the run-wide cost budget. If totalCostCents >= maxTotalCostCents,
   * halt the run in an error state and emit a budget.exhausted webhook.
   */
  private async checkCostBudget(run: AutonomousRun): Promise<boolean> {
    const settings = this.effectiveSettings({
      enabled: true,
      rolloverThreshold: run.rolloverThreshold,
    });
    if (
      typeof settings.maxTotalCostCents === 'number' &&
      settings.maxTotalCostCents > 0 &&
      typeof run.totalCostCents === 'number' &&
      run.totalCostCents >= settings.maxTotalCostCents
    ) {
      run.phase = 'error';
      run.status = 'error';
      run.lastError = `Run cost budget exhausted (${
        run.totalCostCents
      }¢ / ${settings.maxTotalCostCents}¢). Halting to prevent runaway spend.`;
      run.updatedAt = nowISO();
      await this.store.saveRun(run);
      await this.logger.error(
        `cost budget exhausted (${run.totalCostCents}¢ / ${settings.maxTotalCostCents}¢) — run halted`,
        run.runId
      );
      this.emitWebhook('budget.exhausted', run, {
        totalCostCents: run.totalCostCents,
        maxTotalCostCents: settings.maxTotalCostCents,
      });
      return true; // halted
    }
    return false; // ok
  }

  async startRun(input: {
    sessionId: string;
    objective: string;
    settings: AutonomousSettings;
  }): Promise<AutonomousRun> {
    const existing = await this.store.getRun();
    if (existing && existing.status === 'active' && existing.phase !== 'completed') {
      throw new Error('An autonomous run is already active.');
    }
    // Spec 37/62: clear stale lineage so the timeline is clean.
    if (existing) {
      await this.store.clearSessions(existing.runId);
      await this.store.clearRun();
    }
    const run = freshRun({
      objective: input.objective,
      sessionId: input.sessionId,
      threshold: input.settings.rolloverThreshold,
    });
    await this.store.saveRun(run);
    // Record the initial user session under its actual id so rollover can mark
    // it abandoned later. The host (Goose Desktop) created this session; we
    // only track its lineage.
    await createFreshSession(this.store, {
      runId: run.runId,
      role: 'worker',
      generation: run.workerGeneration,
      objective: run.originalObjective,
      sessionId: input.sessionId,
    });
    await this.logger.info(
      `run started — objective: "${truncate(input.objective, 120)}"`,
      run.runId
    );
    await this.logger.info(
      `Worker 01 active (session ${input.sessionId})`,
      run.runId
    );
    this.emitWebhook('run.started', run, { objective: input.objective });
    return run;
  }

  async getState(): Promise<AutonomousRun | null> {
    return this.store.getRun();
  }

  async stopRun(): Promise<AutonomousRun | null> {
    const run = await this.store.getRun();
    if (!run) return null;
    // Spec 43: must not delete sessions, handoff, or logs.
    // v0.5: preserve the pre-stop phase so resumeRun can restore it.
    run.phaseBeforeStop = run.phase;
    run.status = 'stopped';
    run.phase = 'stopped';
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info('run stopped by user', run.runId);
    this.emitWebhook('run.stopped', run);
    return run;
  }

  /**
   * v0.5: Resume a stopped run.
   *
   * Spec §44 said "A stopped run should not automatically resume. The user must
   * explicitly start/resume it." — this method is that explicit resume.
   *
   * - Only works on a `stopped` run.
   * - Restores the run to `active` + the phase it was in when stopped (or
   *   `working` if it was stopped mid-rollover).
   * - Does NOT clear the handoff, sessions, or logs (preserves inspection state).
   * - The current session is reconnected — the host's live session is still valid.
   */
  async resumeRun(): Promise<AutonomousRun | null> {
    const run = await this.store.getRun();
    if (!run) return null;
    if (run.status !== 'stopped') {
      throw new Error(`Cannot resume a run in status '${run.status}' (only 'stopped' runs can be resumed).`);
    }
    run.status = 'active';
    // Restore the phase from before the stop (or default to working)
    const restoredPhase = run.phaseBeforeStop ?? 'working';
    // If we were stopped mid-rollover, resume in 'working' with rollover re-pending
    if (restoredPhase === 'handoff' || restoredPhase === 'creating-session') {
      run.phase = 'working';
      run.rolloverPending = true;
      run.rolloverReason = undefined;
      run.transitionId = undefined;
      run.transitionStage = undefined;
    } else {
      run.phase = restoredPhase;
    }
    run.phaseBeforeStop = undefined;
    // Reset the session-start clock so time-based policies don't immediately trip
    run.currentSessionStartedAt = nowISO();
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(
      `run resumed — phase: ${run.phase}, worker gen: ${run.workerGeneration}`,
      run.runId
    );
    this.emitWebhook('run.resumed', run);
    return run;
  }

  async clearAll(): Promise<void> {
    const run = await this.store.getRun();
    if (run) {
      await this.store.clearSessions(run.runId);
    }
    await this.store.clearRun();
    await this.logger.info('autonomous state cleared');
  }

  /**
   * Spec 18: context notification arrives. Verify session ownership + active
   * run, store usage, mark rollover pending — but DO NOT create a session here.
   *
   * v0.4: evaluates the full rollover policy (context %, turns, time), not just
   * the legacy context threshold. The context policy is the only one that can
   * trip here (turns + time are checked at turn-finish), but we still record
   * the reason so the controller knows why rollover is pending.
   */
  async onContextUsage(
    sessionId: string,
    used: number,
    limit: number
  ): Promise<AutonomousRun | null> {
    const run = await this.store.getRun();
    if (!run || run.status !== 'active') return run;
    // Accept context updates from any session — if the sessionId differs from
    // what we have, update currentSessionId to track the active Goose session.
    // This is essential for the Goose Desktop integration where the session ID
    // is assigned by Goose (not by our startRun call).
    if (sessionId !== run.currentSessionId) {
      run.currentSessionId = sessionId;
    }
    run.contextUsage = used;
    run.contextLimit = limit;

    // v0.4: evaluate the policy. If no rolloverPolicy is configured, fall back
    // to the legacy context-threshold behavior (backward compatible).
    const settings = this.effectiveSettings({
      enabled: true,
      rolloverThreshold: run.rolloverThreshold,
    });
    if (!run.rolloverPending) {
      const policy = resolvePolicy(settings.rolloverPolicy, run.rolloverThreshold);
      const evaluation = evaluateRollover(policy, {
        contextRatio: limit > 0 ? used / limit : 0,
        turnsInSession: run.turnsInCurrentSession ?? 0,
        sessionStartedAt: run.currentSessionStartedAt ?? run.createdAt,
        now: nowISO(),
        sessionCostCents: run.sessionCostCents,
      });
      if (evaluation.shouldRollOver) {
        run.rolloverPending = true;
        run.rolloverReason = evaluation.reason;
        await this.logger.info(
          `rollover pending (${evaluation.description})`,
          run.runId
        );
      }
    }
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    return run;
  }

  /**
   * Spec 19, 20, 22, 49: turn finished. Priority order:
   *   1. verification result
   *   2. worker completion
   *   3. rollover pending (v0.4: re-evaluate turns/time policies here too)
   *   4. otherwise continue
   * Serialized so concurrent turn-finish/context events cannot double-fire.
   */
  async onTurnFinished(
    sessionId: string,
    lastAssistantText: string,
    turn: AgentTurn
  ): Promise<AutonomousRun | null> {
    return this.serialize(async () => {
      const run = await this.store.getRun();
      if (!run || run.status !== 'active') return run;
      if (sessionId !== run.currentSessionId) {
        // Accept turn-finished from any session — update tracking
        run.currentSessionId = sessionId;
      }

      // 1. verification result
      if (run.phase === 'verifying') {
        const v = detectVerificationStatus(lastAssistantText);
        if (v === 'pass') {
          await this.handleVerificationPass(run);
        } else if (v === 'fail') {
          await this.handleVerificationFail(run, lastAssistantText);
        } else {
          // Spec 32: malformed marker => treat as not verified. Stay verifying
          // so the user can inspect; flag an error note.
          run.lastError = 'Verifier produced no recognizable PASS/FAIL marker.';
          run.phase = 'error';
          run.status = 'error';
          run.updatedAt = nowISO();
          await this.store.saveRun(run);
          await this.logger.error(
            'verification produced no marker — phase set to error',
            run.runId
          );
        }
        return run;
      }

      // v0.4: increment the per-session turn counter for worker turns
      run.turnsInCurrentSession = (run.turnsInCurrentSession ?? 0) + 1;

      // v0.5: accumulate token cost for this turn (if the host reported one)
      if (typeof turn.costCents === 'number' && turn.costCents > 0) {
        run.sessionCostCents = (run.sessionCostCents ?? 0) + turn.costCents;
        run.totalCostCents = (run.totalCostCents ?? 0) + turn.costCents;
      }

      // v0.6: check the run-wide cost budget. If exhausted, halt immediately.
      if (await this.checkCostBudget(run)) {
        return run; // halted — budget.exhausted webhook already emitted
      }

      // 2. worker completion (precedence over rollover — spec 22)
      const w = detectWorkerStatus(lastAssistantText);
      if (w === 'complete') {
        await this.handleWorkerComplete(run, lastAssistantText, turn);
        return run;
      }

      // v0.4/v0.5: re-evaluate the rollover policy at the turn boundary. Turns,
      // time, and cost policies can only trip here; the context policy trips in
      // onContextUsage. If rollover is already pending (context tripped), keep it.
      if (!run.rolloverPending) {
        const settings = this.effectiveSettings({
          enabled: true,
          rolloverThreshold: run.rolloverThreshold,
        });
        const policy = resolvePolicy(settings.rolloverPolicy, run.rolloverThreshold);
        const evaluation = evaluateRollover(policy, {
          contextRatio: run.contextLimit && run.contextLimit > 0
            ? (run.contextUsage ?? 0) / run.contextLimit
            : 0,
          turnsInSession: run.turnsInCurrentSession,
          sessionStartedAt: run.currentSessionStartedAt ?? run.createdAt,
          now: nowISO(),
          sessionCostCents: run.sessionCostCents,
        });
        if (evaluation.shouldRollOver) {
          run.rolloverPending = true;
          run.rolloverReason = evaluation.reason;
          await this.logger.info(
            `rollover pending (${evaluation.description})`,
            run.runId
          );
        }
      }

      // 3. rollover pending
      if (run.rolloverPending) {
        await this.performRollover(run, lastAssistantText, turn);
        return run;
      }

      // 4. continue normally
      await this.logger.info(
        `turn finished (gen ${run.workerGeneration}, turn ${run.turnsInCurrentSession}) — continuing`,
        run.runId
      );
      run.updatedAt = nowISO();
      await this.store.saveRun(run);
      return run;
    });
  }

  // ---- transitions ----------------------------------------------------------

  /** Spec 23, 24, 25, 26, 52, 53. */
  private async performRollover(
    run: AutonomousRun,
    _lastText: string,
    _turn: AgentTurn
  ): Promise<void> {
    run.phase = 'handoff';
    run.transitionId = uuid();
    run.transitionStage = undefined;
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info('generating handoff', run.runId);

    const handoff = await this.generateValidatedHandoff(run, run.currentSessionId);
    if (!handoff) {
      // Spec 53: current session remains available; mark error.
      run.phase = 'error';
      run.status = 'error';
      run.lastError = 'Handoff generation failed after retry.';
      run.updatedAt = nowISO();
      await this.store.saveRun(run);
      await this.logger.error('handoff generation failed — phase set to error', run.runId);
      this.emitWebhook('run.failed', run, { reason: 'handoff generation failed' });
      return;
    }

    run.handoff = handoff;
    run.transitionStage = 'handoff-saved';
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info('handoff generated & validated', run.runId);

    // Spec 28: create fresh session.
    run.phase = 'creating-session';
    run.updatedAt = nowISO();
    await this.store.saveRun(run);

    const created = await createFreshSession(this.store, {
      runId: run.runId,
      role: 'worker',
      generation: run.workerGeneration + 1,
      parentSessionId: run.currentSessionId,
      objective: run.originalObjective,
      handoff,
    });
    run.pendingSessionId = created.sessionId;
    run.transitionStage = 'session-created';
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(`${created.name} created (session ${created.sessionId})`, run.runId);

    // Spec 29, 30: send continuation prompt, then navigate.
    const prompt = buildContinuationPrompt(run.originalObjective, handoff, this.deps.handoffSchema);
    await this.deps.sendPrompt({
      sessionId: created.sessionId,
      prompt,
      origin: 'continuation',
    });
    run.transitionStage = 'prompt-sent';
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info('continuation prompt sent', run.runId);

    // Spec 30, 31: navigate AFTER prompt is ready.
    await navigateToSession(this.logger, created.sessionId, run.runId);

    // Spec 59, 60: increment worker generation, mark old session abandoned.
    await this.store.updateSessionStatus(run.currentSessionId, 'abandoned');
    run.previousSessionId = run.currentSessionId;
    run.currentSessionId = created.sessionId;
    run.workerGeneration += 1;
    run.rolloverPending = false;
    run.rolloverReason = undefined;
    run.contextUsage = 0;
    // v0.4: reset per-session tracking for the fresh worker
    run.turnsInCurrentSession = 0;
    run.currentSessionStartedAt = nowISO();
    run.sessionCostCents = 0; // v0.5: reset per-session cost (totalCostCents is preserved)
    run.phase = 'working';
    run.transitionStage = 'session-active';
    run.transitionId = undefined;
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(
      `${formatSessionName('worker', run.workerGeneration)} activated`,
      run.runId
    );
    this.emitWebhook('rollover.completed', run, {
      workerGeneration: run.workerGeneration,
      rolloverReason: run.rolloverReason,
    });
  }

  /** Spec 22, 32, 33, 34: worker COMPLETE -> fresh verification session.
   *  v0.4: enforces the verification budget before creating a new verifier. */
  private async handleWorkerComplete(
    run: AutonomousRun,
    lastText: string,
    _turn: AgentTurn
  ): Promise<void> {
    await this.logger.info(
      `worker reported AUTONOMOUS_STATUS: COMPLETE`,
      run.runId
    );

    // v0.4: check the verification budget BEFORE generating a final handoff.
    // If we've already used all our verification attempts, the run fails in a
    // controlled way instead of looping forever.
    const settings = this.effectiveSettings({
      enabled: true,
      rolloverThreshold: run.rolloverThreshold,
    });
    const nextAttempt = run.verificationAttempt + 1;
    if (verificationBudgetExceeded(nextAttempt - 1, settings.maxVerificationAttempts)) {
      run.phase = 'error';
      run.status = 'error';
      run.lastError = `Verification budget exhausted (${run.verificationAttempt}/${settings.maxVerificationAttempts} attempts). The task could not be verified as complete.`;
      run.updatedAt = nowISO();
      await this.store.saveRun(run);
      await this.logger.error(
        `verification budget exhausted (${run.verificationAttempt}/${settings.maxVerificationAttempts}) — run halted`,
        run.runId
      );
      this.emitWebhook('run.failed', run, {
        reason: 'verification budget exhausted',
        verificationAttempt: run.verificationAttempt,
        maxVerificationAttempts: settings.maxVerificationAttempts,
      });
      return;
    }

    // generate a final handoff (the worker's own summary is insufficient —
    // we ask it for a structured handoff first, per spec 24).
    const finalHandoff = await this.generateValidatedHandoff(run, run.currentSessionId);
    if (!finalHandoff) {
      // Spec 54: do NOT fall back to summarization. Fail controlled.
      run.phase = 'error';
      run.status = 'error';
      run.lastError = 'Final handoff generation failed.';
      run.updatedAt = nowISO();
      await this.store.saveRun(run);
      await this.logger.error('final handoff generation failed', run.runId);
      this.emitWebhook('run.failed', run, { reason: 'final handoff generation failed' });
      return;
    }
    run.handoff = finalHandoff;
    run.verificationAttempt = nextAttempt;
    run.phase = 'verifying';
    run.rolloverPending = false;
    run.rolloverReason = undefined;
    // v0.4: reset per-session tracking for the verifier session
    run.turnsInCurrentSession = 0;
    run.currentSessionStartedAt = nowISO();
    run.sessionCostCents = 0; // v0.5: reset per-session cost (totalCostCents is preserved)
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(
      `verification attempt ${run.verificationAttempt} starting`,
      run.runId
    );
    this.emitWebhook('verification.started', run, { attempt: run.verificationAttempt });

    const created = await createFreshSession(this.store, {
      runId: run.runId,
      role: 'verification',
      generation: run.verificationAttempt,
      parentSessionId: run.currentSessionId,
      objective: run.originalObjective,
      handoff: finalHandoff,
    });
    await this.store.updateSessionStatus(run.currentSessionId, 'completed');

    const prompt = buildVerificationPrompt(run.originalObjective, finalHandoff, this.deps.handoffSchema);
    await this.deps.sendPrompt({
      sessionId: created.sessionId,
      prompt,
      origin: 'verification',
    });
    await navigateToSession(this.logger, created.sessionId, run.runId);

    run.currentSessionId = created.sessionId;
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(
      `${formatSessionName('verification', run.verificationAttempt)} active`,
      run.runId
    );

    void lastText;
  }

  /** Spec 10, 35: verification PASS -> completed. */
  private async handleVerificationPass(run: AutonomousRun): Promise<void> {
    run.status = 'completed';
    run.phase = 'completed';
    run.rolloverPending = false;
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.store.updateSessionStatus(run.currentSessionId, 'completed');
    await this.logger.info('AUTONOMOUS_VERIFICATION: PASS — run completed', run.runId);
    this.emitWebhook('verification.passed', run);
    this.emitWebhook('run.completed', run);
  }

  /** Spec 11, 34: verification FAIL -> findings become next handoff -> new worker. */
  private async handleVerificationFail(run: AutonomousRun, verifierText: string): Promise<void> {
    await this.logger.warn('AUTONOMOUS_VERIFICATION: FAIL — spinning new worker', run.runId);
    await this.store.updateSessionStatus(run.currentSessionId, 'failed');
    this.emitWebhook('verification.failed', run, { findings: extractFindings(verifierText) });

    // Spec 34: the verifier's findings become the next handoff.
    const failHandoff: Handoff = stampObjective(
      {
        objective: run.originalObjective,
        currentState: 'Verification failed. Verifier findings below.',
        completedWork: run.handoff?.completedWork ?? [],
        remainingWork: extractFindings(verifierText),
        filesChanged: run.handoff?.filesChanged ?? [],
        tests: run.handoff?.tests ?? [],
        failures: extractFindings(verifierText),
        decisions: run.handoff?.decisions ?? [],
        constraints: run.handoff?.constraints ?? [],
        nextAction:
          extractNextAction(verifierText) ??
          run.handoff?.nextAction ??
          'Address the verifier findings, then re-run tests.',
        generatedAt: nowISO(),
      },
      run.originalObjective
    );
    run.handoff = failHandoff;

    const created = await createFreshSession(this.store, {
      runId: run.runId,
      role: 'worker',
      generation: run.workerGeneration + 1,
      parentSessionId: run.currentSessionId,
      objective: run.originalObjective,
      handoff: failHandoff,
    });

    const prompt = buildContinuationPrompt(run.originalObjective, failHandoff, this.deps.handoffSchema);
    await this.deps.sendPrompt({
      sessionId: created.sessionId,
      prompt,
      origin: 'continuation',
    });
    await navigateToSession(this.logger, created.sessionId, run.runId);

    run.previousSessionId = run.currentSessionId;
    run.currentSessionId = created.sessionId;
    run.workerGeneration += 1;
    run.phase = 'working';
    run.rolloverPending = false;
    run.rolloverReason = undefined;
    run.contextUsage = 0;
    // v0.4: reset per-session tracking for the fresh worker
    run.turnsInCurrentSession = 0;
    run.currentSessionStartedAt = nowISO();
    run.sessionCostCents = 0; // v0.5: reset per-session cost (totalCostCents is preserved)
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(
      `${formatSessionName('worker', run.workerGeneration)} active (post-verification)`,
      run.runId
    );
  }

  /** Spec 24, 26, 53: generate + validate, retry once on failure.
   *  v0.3: uses the custom handoff schema if one was provided. */
  private async generateValidatedHandoff(
    run: AutonomousRun,
    sessionId: string
  ): Promise<Handoff | null> {
    const useCustomSchema = !!this.deps.handoffSchema;
    const prompt = useCustomSchema
      ? buildHandoffPromptFromSchema(run.originalObjective, this.handoffSchema)
      : buildHandoffPrompt(run.originalObjective);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await this.deps.generateHandoffResponse({
          sessionId,
          objective: run.originalObjective,
          prompt,
        });
        if (!raw) continue;
        if (useCustomSchema) {
          const parsed = parseHandoffResponseWithSchema(raw, this.handoffSchema);
          if (parsed && isValidHandoffAgainstSchema(parsed, this.handoffSchema)) {
            return stampObjective(coerceToHandoff(parsed, run.originalObjective), run.originalObjective);
          }
        } else {
          const parsed = parseHandoffResponse(raw);
          if (parsed && isValidHandoff(parsed)) {
            return stampObjective(parsed, run.originalObjective);
          }
        }
        await this.logger.warn(`handoff parse/validation failed (attempt ${attempt})`, run.runId);
      } catch (e) {
        await this.logger.warn(
          `handoff generation threw (attempt ${attempt}): ${(e as Error).message}`,
          run.runId
        );
      }
    }
    return null;
  }

  // Spec 47: serialize all transitions through one queue.
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.transitionPromise.then(fn, fn);
    this.transitionPromise = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

// ---- prompt builders --------------------------------------------------------

function buildContinuationPrompt(
  objective: string,
  handoff: Handoff,
  schema?: HandoffSchema
): string {
  const serialized = schema
    ? serializeHandoffWithSchema(handoff as unknown as Record<string, unknown>, schema)
    : serializeHandoff(handoff);
  return [
    'You are continuing an autonomous software-development task.',
    '',
    'You are in a COMPLETELY NEW session.',
    'Do NOT assume access to the previous conversation.',
    'Your only sources of truth are: (1) the ORIGINAL OBJECTIVE below,',
    '(2) the HANDOFF below, and (3) the actual repository state you can inspect yourself.',
    '',
    'Do NOT stop merely because the handoff says something is complete.',
    'Verify the actual repository state yourself before trusting any claim.',
    '',
    'ORIGINAL OBJECTIVE:',
    objective,
    '',
    'HANDOFF:',
    serialized,
    '',
    'Continue the work now.',
    '',
    'When the ENTIRE original objective is genuinely complete, end your response with exactly:',
    'AUTONOMOUS_STATUS: COMPLETE',
    '',
    'Otherwise end with exactly:',
    'AUTONOMOUS_STATUS: CONTINUE',
  ].join('\n');
}

function buildVerificationPrompt(
  objective: string,
  handoff: Handoff,
  schema?: HandoffSchema
): string {
  const serialized = schema
    ? serializeHandoffWithSchema(handoff as unknown as Record<string, unknown>, schema)
    : serializeHandoff(handoff);
  return [
    'You are an INDEPENDENT verification agent for an autonomous software-development task.',
    '',
    'You are in a completely new session. Do NOT trust the previous session\'s claims.',
    'Inspect the actual repository yourself.',
    '',
    'Verify the ORIGINAL OBJECTIVE independently:',
    '- Review the implementation.',
    '- Run appropriate tests.',
    '- Check for incomplete work.',
    '- Check for regressions.',
    '- Check that requirements were actually implemented.',
    '',
    'ORIGINAL OBJECTIVE:',
    objective,
    '',
    'WORKER HANDOFF (treat as claims, verify against the real repo):',
    serialized,
    '',
    'If everything is genuinely complete, end your response with exactly:',
    'AUTONOMOUS_VERIFICATION: PASS',
    '',
    'If anything remains incomplete or incorrect, end with exactly:',
    'AUTONOMOUS_VERIFICATION: FAIL',
    'and then list the specific remaining problems.',
  ].join('\n');
}

function extractFindings(text: string): string[] {
  // Heuristic: lines after the FAIL marker that look like findings.
  const idx = text.indexOf('AUTONOMOUS_VERIFICATION: FAIL');
  if (idx === -1) return [];
  const tail = text.slice(idx);
  const lines = tail.split('\n').slice(1);
  return lines
    .map((l) => l.replace(/^[\s\-\*\d.)\]]+/, '').trim())
    .filter((l) => l.length > 3 && l.length < 500)
    .slice(0, 16);
}

function extractNextAction(text: string): string | null {
  const m = text.match(/(?:next|first|then)[:\s]+([^\n]{10,300})/i);
  return m ? m[1].trim() : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
