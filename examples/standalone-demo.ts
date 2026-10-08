// examples/standalone-demo.ts
//
// Run with:  bun examples/standalone-demo.ts
//   (or:    npx tsx examples/standalone-demo.ts)
//
// Demonstrates the full goose-autonomous-sessions state machine end-to-end
// with NO database, NO Electron, NO Next.js — just the portable controller
// wired to in-memory adapters and a mock handoff generator.
//
// You will see:
//   1. A run start
//   2. Context growth across turns
//   3. Context crossing 75% → rollover pending
//   4. The current turn finishing (NOT interrupted)
//   5. A handoff being generated
//   6. A completely fresh Worker 02 session being created
//   7. The fresh worker continuing
//   8. The worker reporting AUTONOMOUS_STATUS: COMPLETE
//   9. A fresh independent verification session being created
//  10. The verifier returning AUTONOMOUS_VERIFICATION: PASS
//  11. The run completing
import { AutonomousSessionController } from '../src/autonomous/controller';
import { inMemoryStore, consoleLogger, getMemSessions } from './in-memory-adapters';

// ─── mock strategies ──────────────────────────────────────────────────────────
// In a real Goose Desktop build:
//   - mockHandoffGenerator → sends a prompt into the current worker session
//     via ACP and reads the structured-JSON response.
//   - mockSendPrompt → calls ACP session/prompt on a fresh session.

async function mockHandoffGenerator(input: {
  sessionId: string;
  objective: string;
  prompt: string;
}): Promise<string | null> {
  // Return a valid handoff JSON. A real impl would call the LLM here.
  return JSON.stringify({
    currentState: 'Mid-task. Some work completed; more remains.',
    completedWork: ['Scaffolded the module', 'Implemented the core function'],
    remainingWork: ['Add remaining features', 'Write tests', 'Update docs'],
    filesChanged: ['src/index.ts'],
    tests: [{ command: 'npm test', result: 'PASS', details: '2/2 tests pass' }],
    failures: [],
    decisions: ['Used a functional style', 'TypeScript strict mode on'],
    constraints: ['Must run in Node 18+', 'No external runtime deps'],
    nextAction: 'Continue implementing the remaining features, then write tests.',
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

// ─── wire the controller ──────────────────────────────────────────────────────
const controller = new AutonomousSessionController({
  store: inMemoryStore,
  logger: consoleLogger,
  generateHandoffResponse: mockHandoffGenerator,
  sendPrompt: mockSendPrompt,
});

// ─── simulate a run ───────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[1m🤖 goose-autonomous-sessions — standalone demo\x1b[0m\n');
  console.log('Objective: "Build a REST API with auth, tests, and docs."\n');

  const run = await controller.startRun({
    sessionId: 'user-session-1',
    objective: 'Build a REST API with auth, tests, and docs.',
    settings: { enabled: true, rolloverThreshold: 0.75 },
  });

  // Each step: (context%) + (assistant text ending in a status marker)
  const steps: { ctx: number; label: string; text: string }[] = [
    { ctx: 30, label: 'worker 1, turn 1', text: 'Scaffolded the project.\n\nAUTONOMOUS_STATUS: CONTINUE' },
    { ctx: 55, label: 'worker 1, turn 2', text: 'Implemented auth.\n\nAUTONOMOUS_STATUS: CONTINUE' },
    { ctx: 78, label: 'worker 1, turn 3 (crosses 75%)', text: 'Implemented routes.\n\nAUTONOMOUS_STATUS: CONTINUE' },
    { ctx: 40, label: 'worker 2, turn 1 (after rollover)', text: 'Added tests.\n\nAUTONOMOUS_STATUS: CONTINUE' },
    { ctx: 25, label: 'worker 2, turn 2', text: 'Wrote docs. Everything is done and tests pass.\n\nAUTONOMOUS_STATUS: COMPLETE' },
    { ctx: 15, label: 'verification', text: 'Independently verified all files and tests. Requirements met.\n\nAUTONOMOUS_VERIFICATION: PASS' },
  ];

  let currentSessionId = run.currentSessionId;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`\n\x1b[1m── turn ${i + 1}: ${step.label} (ctx → ${step.ctx}%) ──\x1b[0m`);

    // 1. push a context-usage update (may trip rollover pending)
    await controller.onContextUsage(currentSessionId, step.ctx * 2000, 200000);

    // 2. the turn finishes — this drives the state machine
    const state = await controller.onTurnFinished(currentSessionId, step.text, {
      sessionId: currentSessionId,
      turnIndex: i + 1,
      role: i === 5 ? 'verification' : 'worker',
      summary: step.text.split('\n')[0],
      filesTouched: [],
      testsRun: [],
      contextBefore: 0,
      contextAfter: step.ctx,
      ts: new Date().toISOString(),
    });

    if (!state) break;
    currentSessionId = state.currentSessionId;

    console.log(
      `  → phase: \x1b[36m${state.phase}\x1b[0m  |  worker gen: ${state.workerGeneration}  |  verify attempt: ${state.verificationAttempt}  |  rollover pending: ${state.rolloverPending}`
    );

    if (state.phase === 'completed') break;
  }

  // ─── summary ────────────────────────────────────────────────────────────────
  const final = await controller.getState();
  const sessions = getMemSessions();

  console.log('\n\x1b[1m─── demo summary ───\x1b[0m');
  console.log(`  final status:  \x1b[32m${final?.status}\x1b[0m`);
  console.log(`  final phase:   ${final?.phase}`);
  console.log(`  sessions created: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`    • ${s.name.padEnd(24)} ${s.role.padEnd(12)} ${s.status}`);
  }
  console.log(`  prompts sent:  ${sentPrompts.length}`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
