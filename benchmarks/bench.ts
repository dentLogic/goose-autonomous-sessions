// benchmarks/bench.ts
//
// v1.0 — performance benchmark suite for the goose-autonomous-sessions public
// API. Measures steady-state throughput of the hot paths a host runtime hits
// every turn:
//
//   1. Controller throughput   — AutonomousSessionController.onTurnFinished
//   2. Handoff validation      — validateHandoff
//   3. Policy evaluation       — evaluateRollover
//   4. Handoff serialization   — serializeHandoff
//   5. HMAC signing            — signPayload
//
// Each benchmark:
//   - warms up for 100 iterations (JIT + cache settle)
//   - measures for at least 10,000 iterations OR 2 seconds, whichever comes first
//   - prints: `  <name>: <N> ops/sec (<N> iterations in <ms>ms)`
//
// Run with:  bun benchmarks/bench.ts
//
// The benchmark uses ONLY in-memory adapters (no DB, no HTTP, no Electron).
// The handoff generator returns a valid handoff JSON string but is never
// invoked on the steady-state continue path — that's intentional. We're
// measuring the per-turn overhead a host pays every time the agent finishes a
// turn without rolling over, completing, or verifying.
//
// All measurements use Bun.nanosecond() (falls back to Date.now() on non-Bun
// runtimes). No external dependencies.
import {
  AutonomousSessionController,
  evaluateRollover,
  serializeHandoff,
  signPayload,
  validateHandoff,
  type AgentTurn,
  type AutonomousRun,
  type AutonomousSettings,
  type Handoff,
  type LoggerAdapter,
  type RolloverPolicy,
  type RolloverEvaluationInput,
  type SessionRecord,
  type StateStoreAdapter,
} from '../src/autonomous';

// ─── timing helpers ─────────────────────────────────────────────────────────

const WARMUP_ITERATIONS = 100;
const MIN_ITERATIONS = 10_000;
const MAX_DURATION_NS = 2_000_000_000n; // 2 seconds in nanoseconds

/** High-resolution monotonic clock. Uses Bun.nanoseconds() when available. */
function nowNs(): bigint {
  if (typeof Bun !== 'undefined' && typeof Bun.nanoseconds === 'function') {
    return BigInt(Bun.nanoseconds());
  }
  // Fallback: Date.now only has millisecond resolution, but multiplied to ns.
  return BigInt(Date.now()) * 1_000_000n;
}

interface BenchResult {
  name: string;
  opsPerSec: number;
  iterations: number;
  elapsedMs: number;
}

function formatResult(r: BenchResult): string {
  // Round ops/sec to a sensible precision (no floating-point noise).
  const ops = r.opsPerSec >= 1000
    ? Math.round(r.opsPerSec).toLocaleString('en-US')
    : r.opsPerSec.toFixed(1);
  return `  ${r.name}: ${ops} ops/sec (${r.iterations.toLocaleString('en-US')} iterations in ${r.elapsedMs.toFixed(1)}ms)`;
}

/** Force GC between benchmarks so each one starts from a clean heap. */
function maybeGc(): void {
  // Bun exposes Bun.gc(true) (synchronous major GC). Node exposes global.gc
  // only when run with --expose-gc. Best-effort — never throws.
  try {
    const g: unknown = (globalThis as any).gc;
    if (typeof g === 'function') g.call(globalThis);
    else if (typeof Bun !== 'undefined' && typeof (Bun as any).gc === 'function') {
      (Bun as any).gc(true);
    }
  } catch {
    /* ignore */
  }
}

/** Run a synchronous benchmark — warmup + measured phase. */
function benchSync(name: string, fn: () => void): BenchResult {
  // Warmup: let the JIT settle, prime inline caches, allocate any closures.
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn();

  // Measured: at least 10k iterations OR 2 seconds, whichever comes first.
  const start = nowNs();
  let iterations = 0;
  while (iterations < MIN_ITERATIONS && (nowNs() - start) < MAX_DURATION_NS) {
    fn();
    iterations++;
  }
  const elapsedNs = nowNs() - start;
  const elapsedSec = Number(elapsedNs) / 1e9;
  const opsPerSec = iterations / elapsedSec;
  return { name, opsPerSec, iterations, elapsedMs: elapsedSec * 1000 };
}

/** Run an asynchronous benchmark — warmup + measured phase, awaiting each call. */
async function benchAsync(name: string, fn: () => Promise<void>): Promise<BenchResult> {
  for (let i = 0; i < WARMUP_ITERATIONS; i++) await fn();

  const start = nowNs();
  let iterations = 0;
  while (iterations < MIN_ITERATIONS && (nowNs() - start) < MAX_DURATION_NS) {
    await fn();
    iterations++;
  }
  const elapsedNs = nowNs() - start;
  const elapsedSec = Number(elapsedNs) / 1e9;
  const opsPerSec = iterations / elapsedSec;
  return { name, opsPerSec, iterations, elapsedMs: elapsedSec * 1000 };
}

// ─── in-memory adapters (no DB, no console spam) ─────────────────────────────

/** Minimal in-memory StateStoreAdapter. One run, one settings, sessions[], []. */
function makeInMemoryStore(): StateStoreAdapter {
  let run: AutonomousRun | null = null;
  const settings: AutonomousSettings = { enabled: true, rolloverThreshold: 0.75 };
  const sessions: SessionRecord[] = [];
  return {
    async getRun() {
      return run;
    },
    async saveRun(r) {
      run = { ...r };
    },
    async clearRun() {
      run = null;
    },
    async getSettings() {
      return { ...settings };
    },
    async saveSettings(s) {
      settings.enabled = s.enabled;
      settings.rolloverThreshold = s.rolloverThreshold;
    },
    async recordSession(input) {
      const ts = new Date().toISOString();
      sessions.push({
        sessionId: input.sessionId,
        runId: input.runId,
        role: input.role,
        generation: input.generation,
        parentSessionId: input.parentSessionId,
        name: input.name,
        status: 'active',
        objective: input.objective,
        handoffJson: input.handoffJson,
        createdAt: ts,
        updatedAt: ts,
      });
    },
    async updateSessionStatus(sessionId, status) {
      const s = sessions.find((x) => x.sessionId === sessionId);
      if (s) {
        s.status = status;
        s.updatedAt = new Date().toISOString();
      }
    },
    async getSessions(runId) {
      const filtered = runId ? sessions.filter((s) => s.runId === runId) : sessions;
      return filtered.map((s) => ({ ...s }));
    },
    async clearSessions(runId) {
      if (runId) {
        for (let i = sessions.length - 1; i >= 0; i--) {
          if (sessions[i].runId === runId) sessions.splice(i, 1);
        }
      } else {
        sessions.length = 0;
      }
    },
  };
}

/** Silent logger — captures nothing, writes nothing. Keeps the hot path pure. */
const silentLogger: LoggerAdapter = {
  async info() {},
  async warn() {},
  async error() {},
};

// ─── sample fixtures (representative real-world sizes) ──────────────────────

const sampleHandoff: Handoff = {
  objective: 'Ship the v1.0 release of goose-autonomous-sessions.',
  currentState:
    'All v0.9 features merged; API stability contract enforced; benchmarks ' +
    'and migration guide written; 167 tests green; package is npm-ready.',
  completedWork: [
    'Implemented context rollover state machine (v0.1)',
    'Added Goose Desktop lifecycle patches + Electron adapters (v0.2)',
    'Added configurable handoff schema (v0.3)',
    'Added verification budget + multi-policy rollover (v0.4)',
    'Added cost-based rollover + run resume (v0.5)',
    'Added run-wide cost budget + webhook notifications (v0.6)',
    'Added HMAC signing + event filtering + delivery log (v0.7)',
    'Added configurable retry policy + dashboard endpoint (v0.8)',
    'Added webhook jitter + event replay + CLI tool (v0.9)',
    'Froze the public API surface (v1.0)',
    'Wrote benchmarks/bench.ts + docs/MIGRATION.md',
  ],
  remainingWork: [
    'Tag v1.0.0 and publish to npm',
    'Cut the GitHub release with the v1.0 changelog',
    'Update the README badges to v1.0',
  ],
  filesChanged: [
    'src/autonomous/controller.ts',
    'src/autonomous/handoff.ts',
    'src/autonomous/rollover-policy.ts',
    'src/autonomous/webhooks.ts',
    'src/autonomous/types.ts',
    'tests/api-stability.test.ts',
    'benchmarks/bench.ts',
    'docs/STABILITY.md',
    'docs/MIGRATION.md',
  ],
  tests: [
    { command: 'bun test', result: 'PASS', details: '167/167 green in ~20s' },
    { command: 'tsc --noEmit', result: 'PASS', details: 'no type errors' },
    { command: 'bun benchmarks/bench.ts', result: 'PASS', details: 'all 5 benchmarks complete' },
  ],
  failures: [],
  decisions: [
    'API stability contract enforced via tests/api-stability.test.ts',
    'Lazy Prisma loading kept (core loads without @/lib/db)',
    'Linux-first; macOS/Windows intentionally deferred',
    'No breaking changes from v0.9 — v1.0 is a stability release',
  ],
  constraints: [
    'No breaking changes to frozen exports (see docs/STABILITY.md)',
    'All optional fields remain optional',
    'Marker strings are frozen (exact-line matching)',
  ],
  nextAction: 'Tag v1.0.0, publish to npm, cut the GitHub release.',
  generatedAt: '2025-01-24T00:00:00.000Z',
};

const sampleHandoffJson = JSON.stringify(sampleHandoff);

const samplePolicy: RolloverPolicy = {
  contextPercent: 0.75,
  maxTurnsPerSession: 20,
  maxMinutesPerSession: 30,
  maxCostCentsPerSession: 100,
};

const sampleEvalInput: RolloverEvaluationInput = {
  contextRatio: 0.42,
  turnsInSession: 7,
  sessionStartedAt: '2025-01-24T00:00:00.000Z',
  now: '2025-01-24T00:12:34.000Z',
  sessionCostCents: 23,
};

const sampleWebhookBody = JSON.stringify({
  event: 'rollover.completed',
  runId: '00000000-0000-4000-8000-000000000000',
  emittedAt: '2025-01-24T00:12:34.000Z',
  run: {
    status: 'active',
    phase: 'working',
    workerGeneration: 3,
    verificationAttempt: 0,
    totalCostCents: 47,
    sessionCostCents: 12,
  },
  details: { rolloverReason: 'context' },
});

const sampleTurn: AgentTurn = {
  sessionId: 'sess-0001',
  turnIndex: 1,
  role: 'worker',
  summary: 'Implemented the new feature and added tests.',
  filesTouched: ['src/feature.ts', 'tests/feature.test.ts'],
  testsRun: [{ command: 'bun test', result: 'PASS' }],
  contextBefore: 12000,
  contextAfter: 14200,
  ts: '2025-01-24T00:12:34.000Z',
};

// ─── benchmark 1: controller throughput ─────────────────────────────────────
//
// Measures AutonomousSessionController.onTurnFinished — the hottest host path.
// Each iteration:
//   - serializes via the controller's transition queue
//   - reads the run from the in-memory store
//   - checks phase + status + sessionId ownership
//   - increments the per-session turn counter
//   - evaluates the rollover policy (no policy trips on the steady path)
//   - calls the silent logger
//   - writes the run back to the in-memory store
//
// The mock handoff generator returns valid JSON but is NOT invoked on the
// continue path — we're measuring steady-state per-turn overhead, not a
// rollover cycle (which would call out to the LLM).

async function benchControllerThroughput(): Promise<BenchResult> {
  const store = makeInMemoryStore();
  // Mock handoff generator — returns a valid handoff JSON string. Won't be
  // called on the steady continue path, but must be supplied (ControllerDeps
  // requires it) and must produce valid output if a rollover is ever triggered.
  const generateHandoffResponse = async (): Promise<string | null> => sampleHandoffJson;
  const sendPrompt = async (): Promise<void> => {};

  const controller = new AutonomousSessionController({
    store,
    logger: silentLogger,
    generateHandoffResponse,
    sendPrompt,
    // Inject settings so the controller doesn't look them up from the store
    // every turn. rolloverThreshold = 1.0 + no rolloverPolicy means no policy
    // can trip on the continue path — the benchmark exercises the steady state.
    settings: { enabled: true, rolloverThreshold: 1.0 },
  });

  // Start one run, then hammer it with turns.
  const sessionId = 'sess-0001';
  await controller.startRun({
    sessionId,
    objective: sampleHandoff.objective,
    settings: { enabled: true, rolloverThreshold: 1.0 },
  });

  return benchAsync('Controller onTurnFinished', async () => {
    await controller.onTurnFinished(sessionId, 'WORKING — no markers', sampleTurn);
  });
}

// ─── benchmark 2: handoff validation throughput ─────────────────────────────

function benchHandoffValidation(): BenchResult {
  return benchSync('validateHandoff', () => {
    validateHandoff(sampleHandoff);
  });
}

// ─── benchmark 3: policy evaluation throughput ──────────────────────────────

function benchPolicyEvaluation(): BenchResult {
  return benchSync('evaluateRollover', () => {
    evaluateRollover(samplePolicy, sampleEvalInput);
  });
}

// ─── benchmark 4: handoff serialization throughput ─────────────────────────

function benchHandoffSerialization(): BenchResult {
  return benchSync('serializeHandoff', () => {
    serializeHandoff(sampleHandoff);
  });
}

// ─── benchmark 5: HMAC signing throughput ──────────────────────────────────

function benchHmacSigning(): BenchResult {
  const secret = 'whkit-webhook-secret-v1';
  return benchSync('signPayload (HMAC-SHA256)', () => {
    signPayload(secret, sampleWebhookBody);
  });
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('goose-autonomous-sessions — v1.0 benchmark suite');
  console.log('='.repeat(60));
  console.log(`runtime: ${typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : 'non-Bun'}`);
  console.log(
    `config: ${WARMUP_ITERATIONS} warmup iters, ≥${MIN_ITERATIONS.toLocaleString('en-US')} measured ` +
      `iters or 2s (whichever comes first)`
  );
  console.log('');

  const results: BenchResult[] = [];

  // 1. Controller (async).
  maybeGc();
  results.push(await benchControllerThroughput());

  // 2-5. Pure functions (sync).
  maybeGc();
  results.push(benchHandoffValidation());
  maybeGc();
  results.push(benchPolicyEvaluation());
  maybeGc();
  results.push(benchHandoffSerialization());
  maybeGc();
  results.push(benchHmacSigning());

  console.log('Results:');
  for (const r of results) console.log(formatResult(r));

  console.log('');
  console.log('Notes:');
  console.log('  • Controller throughput includes the transition queue + in-memory');
  console.log('    store round-trip + silent logger + policy evaluation. It is the');
  console.log('    per-turn overhead a host pays on the steady continue path.');
  console.log('  • Pure-function benchmarks (validateHandoff, evaluateRollover,');
  console.log('    serializeHandoff, signPayload) measure the same hot paths the');
  console.log('    controller invokes internally — useful for spotting regressions');
  console.log('    in isolation.');
  console.log('  • Numbers vary by hardware. Compare relative trends across versions,');
  console.log('    not absolute values.');
}

main().catch((err) => {
  console.error('benchmark failed:', err);
  process.exit(1);
});
