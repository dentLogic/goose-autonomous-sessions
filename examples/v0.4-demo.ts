// examples/v0.4-demo.ts
//
// Run with:  bun examples/v0.4-demo.ts
//
// Demonstrates the v0.4 features:
//   1. Turn-based rollover policy (rollover after N turns, not just context %)
//   2. Verification budget (maxVerificationAttempts halts infinite loops)
//
// Watch the controller roll over every 2 turns — without any context pressure —
// and then halt cleanly when the verification budget is exhausted.
import { AutonomousSessionController } from '../src/autonomous/controller';
import { inMemoryStore, consoleLogger, getMemSessions } from './in-memory-adapters';

async function mockHandoffGenerator(input: {
  sessionId: string;
  objective: string;
  prompt: string;
}): Promise<string | null> {
  return JSON.stringify({
    currentState: 'Mid-task.',
    completedWork: ['some work'],
    remainingWork: ['more work'],
    filesChanged: ['src/foo.ts'],
    tests: [{ command: 'npm test', result: 'PASS' }],
    failures: [],
    decisions: ['decided X'],
    constraints: ['must be fast'],
    nextAction: 'continue the work',
  });
}

const sentPrompts: { sessionId: string; origin: string }[] = [];

async function mockSendPrompt(input: {
  sessionId: string;
  prompt: string;
  origin: 'continuation' | 'verification';
}): Promise<void> {
  sentPrompts.push({ sessionId: input.sessionId, origin: input.origin });
  await consoleLogger.info(`[prompt:${input.origin}] → session ${input.sessionId.slice(0, 12)}`);
}

// v0.4: configure turn-based rollover + a verification budget
const controller = new AutonomousSessionController({
  store: inMemoryStore,
  logger: consoleLogger,
  generateHandoffResponse: mockHandoffGenerator,
  sendPrompt: mockSendPrompt,
  settings: {
    enabled: true,
    rolloverThreshold: 0.99, // high — we want turn-based, not context-based
    rolloverPolicy: {
      contextPercent: 0.99,
      maxTurnsPerSession: 2,   // ← roll over every 2 turns
    },
    maxVerificationAttempts: 2, // ← halt after 2 failed verifications
  },
});

async function main() {
  console.log('\n\x1b[1m🤖 goose-autonomous-sessions — v0.4 demo\x1b[0m');
  console.log('   turn-based rollover (every 2 turns) + verification budget (max 2)\x1b[0m\n');
  console.log('Objective: "Build a feature that never quite passes verification."\n');

  const run = await controller.startRun({
    sessionId: 'user-session-1',
    objective: 'Build a feature that never quite passes verification.',
    settings: { enabled: true, rolloverThreshold: 0.99 }, // overridden by deps.settings
  });

  let currentSessionId = run.currentSessionId;
  let turnCount = 0;

  // The worker will keep completing, but verification keeps failing.
  // The controller should:
  //   - roll over every 2 worker turns (turn policy)
  //   - halt after 2 verification attempts (budget)
  for (let i = 1; i <= 12; i++) {
    const state = await controller.getState();
    if (!state || state.status !== 'active') {
      console.log(`\n── run halted at step ${i} (status: ${state?.status}) ──`);
      break;
    }
    currentSessionId = state.currentSessionId;

    if (state.phase === 'verifying') {
      // Verifier always fails in this demo
      console.log(`\n\x1b[1m── step ${i}: verification → FAIL ──\x1b[0m`);
      await controller.onTurnFinished(
        currentSessionId,
        'AUTONOMOUS_VERIFICATION: FAIL\n- still incomplete',
        {
          sessionId: currentSessionId,
          turnIndex: i,
          role: 'verification',
          summary: 'FAIL',
          filesTouched: [],
          testsRun: [],
          contextBefore: 0,
          contextAfter: 0,
          ts: new Date().toISOString(),
        }
      );
    } else {
      // Worker — alternate between CONTINUE and COMPLETE
      turnCount += 1;
      const willComplete = turnCount >= 2; // complete after 2 turns
      const marker = willComplete ? 'AUTONOMOUS_STATUS: COMPLETE' : 'AUTONOMOUS_STATUS: CONTINUE';
      console.log(`\n\x1b[1m── step ${i}: worker turn ${turnCount} → ${marker.split(': ')[1]}\x1b[0m`);
      await controller.onTurnFinished(
        currentSessionId,
        `did some work\n\n${marker}`,
        {
          sessionId: currentSessionId,
          turnIndex: i,
          role: 'worker',
          summary: 'work',
          filesTouched: [],
          testsRun: [],
          contextBefore: 0,
          contextAfter: 10,
          ts: new Date().toISOString(),
        }
      );
      if (willComplete) turnCount = 0; // reset for the next worker
    }
  }

  const final = await controller.getState();
  const sessions = getMemSessions();

  console.log('\n\x1b[1m─── v0.4 demo summary ───\x1b[0m');
  console.log(`  final status:  \x1b[${final?.status === 'error' ? '31' : '32'}m${final?.status}\x1b[0m`);
  console.log(`  final phase:   ${final?.phase}`);
  console.log(`  worker gen:    ${final?.workerGeneration}`);
  console.log(`  verify attempt: ${final?.verificationAttempt} (budget was 2)`);
  if (final?.lastError) {
    console.log(`  last error:    \x1b[31m${final.lastError}\x1b[0m`);
  }
  console.log(`  sessions created: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`    • ${s.name.padEnd(24)} ${s.role.padEnd(12)} ${s.status}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
