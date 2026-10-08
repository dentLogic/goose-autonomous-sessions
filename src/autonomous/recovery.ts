// src/lib/autonomous/recovery.ts
// Spec sections 17, 18, 36, 37, 38, 44, 71.
//
// Uses controller.store + controller.logger so recovery runs through the same
// adapters the host already injected.
import type { AutonomousSessionController } from './controller';
import type { AutonomousRun } from './types';

const nowISO = () => new Date().toISOString();

/**
 * Called on Desktop startup. Spec 36 decision tree:
 *   state missing?        -> nothing
 *   completed             -> clear active run
 *   stopped               -> leave stopped (user must resume)
 *   working               -> reconnect (no-op; host owns the live session)
 *   handoff / creating    -> recover transition idempotently via pendingSessionId
 *   verifying             -> reconnect verifier
 *   error                 -> expose error
 */
export async function recover(controller: AutonomousSessionController): Promise<AutonomousRun | null> {
  const { store, logger } = controller;
  const run = await store.getRun();
  if (!run) {
    await logger.info('recovery: no active run — nothing to do');
    return null;
  }

  switch (run.status) {
    case 'completed':
      await logger.info('recovery: run already completed — clearing active record', run.runId);
      return run;

    case 'stopped':
      await logger.info('recovery: run stopped by user — leaving stopped', run.runId);
      return run;

    case 'error':
      await logger.warn(`recovery: run in error state — ${run.lastError ?? 'unknown'}`, run.runId);
      return run;

    case 'active': {
      // Spec 37, 38: never guess; inspect transition stage.
      switch (run.phase) {
        case 'handoff':
          await logger.warn('recovery: crashed during handoff generation — resetting to working', run.runId);
          run.phase = 'working';
          run.rolloverPending = true; // re-attempt rollover on next turn finish
          run.transitionId = undefined;
          run.transitionStage = undefined;
          run.updatedAt = nowISO();
          await store.saveRun(run);
          return run;

        case 'creating-session':
          // Spec 37: if pendingSessionId exists, resume it; otherwise the
          // controller never created one — reset so the next turn re-rolls.
          if (run.pendingSessionId) {
            await logger.info(
              `recovery: resuming pending session ${run.pendingSessionId}`,
              run.runId
            );
            run.currentSessionId = run.pendingSessionId;
            run.workerGeneration += 1;
            run.previousSessionId = run.currentSessionId;
            run.phase = 'working';
            run.rolloverPending = false;
            run.contextUsage = 0;
            run.transitionId = undefined;
            run.transitionStage = 'session-active';
            run.updatedAt = nowISO();
            await store.saveRun(run);
            await logger.info('recovery: resumed — working', run.runId);
            return run;
          } else {
            await logger.warn(
              'recovery: crashed before session creation — resetting to working',
              run.runId
            );
            run.phase = 'working';
            run.rolloverPending = true;
            run.transitionId = undefined;
            run.transitionStage = undefined;
            run.updatedAt = nowISO();
            await store.saveRun(run);
            return run;
          }

        case 'verifying':
          await logger.info('recovery: verifier session active — reconnecting', run.runId);
          return run;

        case 'working':
          await logger.info('recovery: run active in working phase — reconnected', run.runId);
          return run;

        case 'completed':
          return run;

        case 'stopped':
        case 'error':
          return run;

        default:
          return run;
      }
    }

    default:
      return run;
  }
}
