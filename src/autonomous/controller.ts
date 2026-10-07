// src/lib/autonomous/controller.ts
// Spec sections 12, 13, 14, 15, 19, 22, 28, 32, 33, 34, 35, 47, 49, 50, 57, 58, 59, 60.
//
// The controller has ZERO hard dependencies on any persistence layer or host
// runtime. State storage and logging are injected as adapters (StateStoreAdapter
// / LoggerAdapter), so the same controller class runs unchanged inside:
//   - Goose Desktop  (Electron main-process adapters)
//   - a Next.js app   (Prisma/SQLite adapters — see ./stateStore.ts + ./logger.ts)
//   - a standalone script (in-memory adapters — see examples/)
import { randomUUID } from 'crypto';
import { AUTONOMOUS_SCHEMA_VERSION, DEFAULT_CONTEXT_LIMIT } from './constants';
import { shouldMarkRolloverPending } from './contextMonitor';
import { detectVerificationStatus, detectWorkerStatus } from './completionDetector';
import {
  buildHandoffPrompt,
  isValidHandoff,
  parseHandoffResponse,
  serializeHandoff,
  stampObjective,
} from './handoff';
import { navigateToSession } from './navigation';
import { createFreshSession, formatSessionName } from './sessionManager';
import type {
  AgentTurn,
  AutonomousRun,
  AutonomousSettings,
  Handoff,
  LoggerAdapter,
  StateStoreAdapter,
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
}

const nowISO = () => new Date().toISOString();

function freshRun(input: {
  objective: string;
  sessionId: string;
  threshold: number;
}): AutonomousRun {
  const ts = nowISO();
  return {
    schemaVersion: AUTONOMOUS_SCHEMA_VERSION,
    runId: randomUUID(),
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
  };
}

// ---- public API -------------------------------------------------------------

export class AutonomousSessionController {
  // Spec 47: serialized transition queue to prevent double-rollover.
  private transitionPromise: Promise<void> = Promise.resolve();
  /** Exposed so recovery.ts can reuse the same adapters. */
  readonly store: StateStoreAdapter;
  readonly logger: LoggerAdapter;

  constructor(private deps: ControllerDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
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
    return run;
  }

  async getState(): Promise<AutonomousRun | null> {
    return this.store.getRun();
  }

  async stopRun(): Promise<AutonomousRun | null> {
    const run = await this.store.getRun();
    if (!run) return null;
    // Spec 43: must not delete sessions, handoff, or logs.
    run.status = 'stopped';
    run.phase = 'stopped';
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info('run stopped by user', run.runId);
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
   */
  async onContextUsage(
    sessionId: string,
    used: number,
    limit: number
  ): Promise<AutonomousRun | null> {
    const run = await this.store.getRun();
    if (!run || run.status !== 'active') return run;
    if (sessionId !== run.currentSessionId) return run;
    run.contextUsage = used;
    run.contextLimit = limit;
    // Spec 48: only the first crossing flips the flag.
    if (!run.rolloverPending && shouldMarkRolloverPending(used, limit, run.rolloverThreshold)) {
      run.rolloverPending = true;
      await this.logger.info(
        `context threshold reached (${Math.round((used / limit) * 100)}%) — rollover pending`,
        run.runId
      );
    }
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    return run;
  }

  /**
   * Spec 19, 20, 22, 49: turn finished. Priority order:
   *   1. verification result
   *   2. worker completion
   *   3. rollover pending
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
      if (sessionId !== run.currentSessionId) return run;

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

      // 2. worker completion (precedence over rollover — spec 22)
      const w = detectWorkerStatus(lastAssistantText);
      if (w === 'complete') {
        await this.handleWorkerComplete(run, lastAssistantText, turn);
        return run;
      }

      // 3. rollover pending
      if (run.rolloverPending) {
        await this.performRollover(run, lastAssistantText, turn);
        return run;
      }

      // 4. continue normally
      await this.logger.info(
        `turn finished (gen ${run.workerGeneration}) — continuing`,
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
    run.transitionId = randomUUID();
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
    const prompt = buildContinuationPrompt(run.originalObjective, handoff);
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
    run.contextUsage = 0;
    run.phase = 'working';
    run.transitionStage = 'session-active';
    run.transitionId = undefined;
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(
      `${formatSessionName('worker', run.workerGeneration)} activated`,
      run.runId
    );
  }

  /** Spec 22, 32, 33, 34: worker COMPLETE -> fresh verification session. */
  private async handleWorkerComplete(
    run: AutonomousRun,
    lastText: string,
    _turn: AgentTurn
  ): Promise<void> {
    await this.logger.info(
      `worker reported AUTONOMOUS_STATUS: COMPLETE`,
      run.runId
    );

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
      return;
    }
    run.handoff = finalHandoff;
    run.verificationAttempt += 1;
    run.phase = 'verifying';
    run.rolloverPending = false;
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(
      `verification attempt ${run.verificationAttempt} starting`,
      run.runId
    );

    const created = await createFreshSession(this.store, {
      runId: run.runId,
      role: 'verification',
      generation: run.verificationAttempt,
      parentSessionId: run.currentSessionId,
      objective: run.originalObjective,
      handoff: finalHandoff,
    });
    await this.store.updateSessionStatus(run.currentSessionId, 'completed');

    const prompt = buildVerificationPrompt(run.originalObjective, finalHandoff);
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
  }

  /** Spec 11, 34: verification FAIL -> findings become next handoff -> new worker. */
  private async handleVerificationFail(run: AutonomousRun, verifierText: string): Promise<void> {
    await this.logger.warn('AUTONOMOUS_VERIFICATION: FAIL — spinning new worker', run.runId);
    await this.store.updateSessionStatus(run.currentSessionId, 'failed');

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

    const prompt = buildContinuationPrompt(run.originalObjective, failHandoff);
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
    run.contextUsage = 0;
    run.updatedAt = nowISO();
    await this.store.saveRun(run);
    await this.logger.info(
      `${formatSessionName('worker', run.workerGeneration)} active (post-verification)`,
      run.runId
    );
  }

  /** Spec 24, 26, 53: generate + validate, retry once on failure. */
  private async generateValidatedHandoff(
    run: AutonomousRun,
    sessionId: string
  ): Promise<Handoff | null> {
    const prompt = buildHandoffPrompt(run.originalObjective);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await this.deps.generateHandoffResponse({
          sessionId,
          objective: run.originalObjective,
          prompt,
        });
        if (!raw) continue;
        const parsed = parseHandoffResponse(raw);
        if (parsed && isValidHandoff(parsed)) {
          return stampObjective(parsed, run.originalObjective);
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

function buildContinuationPrompt(objective: string, handoff: Handoff): string {
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
    serializeHandoff(handoff),
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

function buildVerificationPrompt(objective: string, handoff: Handoff): string {
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
    serializeHandoff(handoff),
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
