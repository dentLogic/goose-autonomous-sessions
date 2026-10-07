# Benchmarks

Performance benchmark suite for `goose-autonomous-sessions` v1.0.

These benchmarks measure the **steady-state throughput** of the hot paths a host
runtime (Goose Desktop, a Next.js app, a standalone script) hits every time the
agent finishes a turn. They do **not** measure LLM latency, HTTP latency, or
disk I/O — those are host-specific and outside the scope of the portable core.

## What is measured

| # | Benchmark | What it exercises |
|---|-----------|--------------------|
| 1 | **Controller onTurnFinished** | The full per-turn pipeline: transition queue serialization, in-memory store round-trip, phase/status/sessionId checks, turn counter increment, rollover policy evaluation, silent logger call, store write. This is the per-turn overhead a host pays on the steady continue path. |
| 2 | **validateHandoff** | The field-by-field validator (`validateHandoff`) over a representative 9-field handoff. Returns an empty error array on the sample input (the success path). |
| 3 | **evaluateRollover** | The 4-policy evaluator (`contextPercent` / `maxTurnsPerSession` / `maxMinutesPerSession` / `maxCostCentsPerSession`) over a sample input where no policy trips — exercises the full decision tree end-to-end. |
| 4 | **serializeHandoff** | The compact text serializer (`serializeHandoff`) — renders the handoff into the multi-section text block embedded in continuation prompts. String-heavy, allocation-heavy. |
| 5 | **signPayload (HMAC-SHA256)** | The webhook payload signer (`signPayload`). Computes `sha256=<hex>` over a representative ~300-byte webhook payload body. |

The controller benchmark uses in-memory `StateStoreAdapter` + silent
`LoggerAdapter` implementations. The mock handoff generator returns a valid
handoff JSON string but is **never invoked** on the steady continue path — we're
measuring per-turn overhead, not a rollover cycle (which would call out to the
LLM and dominate the measurement).

## How to run

```bash
bun benchmarks/bench.ts
```

Requirements:

- [Bun](https://bun.sh/) ≥ 1.0 (uses `Bun.nanosecond()` for high-resolution timing)
- No external dependencies — the suite imports only from `../src/autonomous`

### Example output

```
goose-autonomous-sessions — v1.0 benchmark suite
============================================================
runtime: Bun 1.3.14
config: 100 warmup iters, ≥10,000 measured iters or 2s (whichever comes first)

Results:
  Controller onTurnFinished: 384,615 ops/sec (10,000 iterations in 26.0ms)
  validateHandoff: 1,250,000 ops/sec (10,000 iterations in 8.0ms)
  evaluateRollover: 1,666,667 ops/sec (10,000 iterations in 6.0ms)
  serializeHandoff: 172,414 ops/sec (10,000 iterations in 58.0ms)
  signPayload (HMAC-SHA256): 769,231 ops/sec (10,000 iterations in 13.0ms)
```

(Numbers above are from a single run on commodity hardware — yours will vary.
See [How to interpret results](#how-to-interpret-results) below.)

## Methodology

Each benchmark runs two phases:

1. **Warmup** — 100 iterations. Lets the JIT settle, primes inline caches,
   allocates closures, and warms up the in-memory store. Not measured.
2. **Measured** — runs until either 10,000 iterations have completed OR 2
   seconds have elapsed, whichever comes first.

The benchmark then reports:

```
  <name>: <N> ops/sec (<N> iterations in <ms>ms)
```

Where `ops/sec = iterations / elapsed_seconds` and `ms` is the wall-clock
duration of the measured phase.

Between benchmarks, the suite calls `Bun.gc(true)` (or `global.gc()` if
available) to start each measurement from a clean heap. This is best-effort and
silently skipped on runtimes that don't expose GC.

### Why "at least 10,000 iterations or 2 seconds"?

- **10,000 iterations** is enough to amortize one-off costs (V8 warmup,
  megamorphic cache misses) for fast functions that finish in microseconds.
- **2 seconds** is enough to see steady-state behavior on slow paths (the
  controller benchmark on a cold cache, the serializer on large payloads)
  without making the suite tedious to run.

For all five benchmarks on commodity hardware, the iteration cap is hit well
before the time cap — they all finish 10,000 iterations in under 60ms. This is
intentional: the suite is meant to be a fast smoke test you can run in CI.

## How to interpret results

### Absolute numbers

Don't read too much into absolute ops/sec values — they vary by:

- CPU model, clock speed, cache size
- Bun version (different V8/JSC tiers)
- OS scheduler noise
- Whether the machine is on battery, thermal-throttled, etc.

The numbers above (384K controller ops/sec, 1.66M evaluateRollover ops/sec)
were captured on a single Linux machine. Your numbers will differ.

### Relative trends

The benchmarks are most useful as a **regression detector** across releases:

- Run the suite on the same machine before and after a change.
- If `Controller onTurnFinished` drops by >25%, something regressed.
- If a pure-function benchmark drops by >50%, something is wrong.

A typical workflow is to capture baseline numbers at release time
(e.g. write them into a `BENCHMARKS.md` next to this README), then re-run on
the same machine before tagging the next release.

### Per-benchmark expectations

| Benchmark | Expected order of magnitude | Why |
|-----------|----------------------------|-----|
| `Controller onTurnFinished` | 10⁵ ops/sec | Async, serialized through a promise chain, includes store round-trip + logger call. The slowest of the five. |
| `validateHandoff` | 10⁶ ops/sec | Pure sync, walks ~10 fields with type checks. Should be faster than the controller. |
| `evaluateRollover` | 10⁶ ops/sec | Pure sync, 4 policy checks. Should be the fastest of the five (no allocations on the no-trip path). |
| `serializeHandoff` | 10⁵ ops/sec | String-heavy — joins ~30 lines into a multi-section text block. The slowest pure function by design. |
| `signPayload` | 10⁵–10⁶ ops/sec | Bound by `createHmac('sha256', …)`. Crypto-internal, not user-code. |

If `Controller onTurnFinished` is dramatically slower than `validateHandoff` +
`evaluateRollover` + `serializeHandoff` combined, the controller is paying
overhead beyond what its constituent functions cost — investigate the
transition queue, the store round-trip, or the webhook emitter.

### A note on the controller benchmark

The controller benchmark intentionally exercises the **continue path** — the
branch where `onTurnFinished` does not roll over, complete, or verify. This is
the path that runs on every normal agent turn, so it's the most important one
to keep fast.

The rollover / completion / verification paths invoke the (mock) handoff
generator and are not benchmarked here. In production, those paths are
dominated by LLM latency (seconds to minutes per call), so micro-benchmarking
them in isolation would not produce useful numbers.

## Files

```
benchmarks/
├── README.md   ← this file
└── bench.ts    ← the benchmark suite (run with: bun benchmarks/bench.ts)
```

## Related

- [`docs/STABILITY.md`](../docs/STABILITY.md) — the public API surface these
  benchmarks exercise. If a benchmark fails to import, it's a sign a frozen
  export was renamed or removed (a breaking change).
- [`tests/api-stability.test.ts`](../tests/api-stability.test.ts) — the
  contract test that catches API breakage. Run it alongside the benchmarks.
- [`docs/MIGRATION.md`](../docs/MIGRATION.md) — v0.9 → v1.0 migration guide.
