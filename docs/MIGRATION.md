# Migration Guide — v0.x → v1.0

This guide walks you through upgrading from any v0.x release of
`goose-autonomous-sessions` to **v1.0**. The short version is:

> **v1.0 is a stability release. There are no breaking changes for v0.9 users.
> Your code keeps working as-is.**

If you wrote code against v0.9 (or any earlier v0.x), you do not need to change
anything to use v1.0. The library's import paths, function signatures, types,
and runtime behavior are all unchanged. v1.0 is v0.9 with two additions
(an API stability contract test, and a benchmark suite) and one
non-behavioral clarification (lazy Prisma loading is now an explicit guarantee,
not an implementation detail).

The rest of this document explains what changed, why, how to verify your code
is v1.0-compatible, and what to expect from future v1.x and v2.0 releases.

---

## TL;DR

| Question | Answer |
|----------|--------|
| Do I need to change my code? | **No.** |
| Are there breaking changes from v0.9? | **No.** |
| Are there new exports / fields / methods? | **No.** v1.0 ships no new runtime features. |
| What's actually new? | `tests/api-stability.test.ts` (contract test) and `benchmarks/bench.ts` (perf suite). |
| What's the recommended upgrade action? | Bump your dependency, re-run the API stability test, optionally capture baseline benchmark numbers. |
| Will v1.0 break when v1.1 ships? | **No.** v1.x is additive only (see [Future upgrade path](#future-upgrade-path-v1x-and-v20)). |

---

## What changed from v0.9 to v1.0

### 1. API stability freeze

The single most important change in v1.0 is that the **public API surface is
now frozen**. Every export from `src/autonomous/index.ts` is documented in
[`docs/STABILITY.md`](./STABILITY.md) and marked **@stable** (frozen) or
**@experimental** (may change in a minor release).

From v1.0 onward, changes to frozen exports follow Semantic Versioning:

| Change | Version bump | Examples |
|--------|-------------|----------|
| Bug fix, no API change | **Patch** (1.0.x) | Fix a typo in an error message; tweak a regex internally |
| Additive — new export, new optional field, new optional method param | **Minor** (1.x.0) | Add `RolloverPolicy.maxRetriesPerSession`; add `AutonomousRun.lastWebhookEmittedAt` |
| Breaking — removed export, renamed function, required field, type narrowing | **Major** (2.0.0) | Rename `signPayload` → `sign`; remove `prismaLogger`; make `rolloverThreshold` required-on-construct |

This is enforced by a new contract test,
[`tests/api-stability.test.ts`](../tests/api-stability.test.ts), which asserts
that every frozen export exists, has the expected type, and (for the pure
functions) behaves correctly on representative inputs. **If the contract test
fails, a frozen export was changed — that's a breaking change requiring a
major version bump.**

### 2. Lazy Prisma loading — now an explicit guarantee

`src/autonomous/stateStore.ts` and `src/autonomous/logger.ts` (the Prisma-backed
reference adapters) have always imported Prisma lazily via dynamic
`import('@/lib/db')`. In v1.0, this is no longer an implementation detail —
it's an explicit guarantee documented in [`docs/STABILITY.md`](./STABILITY.md):

> **The portable core (`src/autonomous/*` minus `stateStore.ts` and `logger.ts`)
> has zero hard dependencies.** The module loads successfully without Prisma,
> Electron, or any host runtime installed.

What this means in practice:

- `import { AutonomousSessionController, validateHandoff, … } from 'goose-autonomous-sessions'`
  works on any host that has TypeScript — even one without Prisma, without
  `@/lib/db`, without a `schema.prisma` file.
- Only `prismaStateStore` and `prismaLogger` (the experimental reference
  adapters) require Prisma, and they only attempt the `@/lib/db` import when
  one of their methods is actually called — never on module load.

If you were importing from the barrel export (`src/autonomous/index.ts`) and
your code worked under v0.9, it will work under v1.0 unchanged. The lazy-loading
behavior is identical; the only difference is that it is now a documented
contract.

### 3. New: API stability test

A new file: [`tests/api-stability.test.ts`](../tests/api-stability.test.ts).
Run it with:

```bash
bun test tests/api-stability.test.ts
```

It asserts:

- All frozen types, classes, functions, and constants are exported.
- Controller methods (`startRun`, `onContextUsage`, `onTurnFinished`,
  `stopRun`, `resumeRun`, `clearAll`, `getState`) exist on the controller.
- Marker strings (`AUTONOMOUS_STATUS: COMPLETE`, etc.) have the exact frozen
  format.
- IPC channel names (`autonomous:get-state`, etc.) are frozen.
- The schema version is `1`.
- The default settings have the expected shape.
- Pure functions return the expected values on representative inputs.

This test is your **canary** for API breakage across versions.

### 4. New: benchmark suite

A new directory: [`benchmarks/`](../benchmarks/). Run it with:

```bash
bun benchmarks/bench.ts
```

It measures steady-state throughput for five hot paths:

1. `AutonomousSessionController.onTurnFinished`
2. `validateHandoff`
3. `evaluateRollover`
4. `serializeHandoff`
5. `signPayload` (HMAC-SHA256)

The benchmark is meant to be a **regression detector** across releases —
capture baseline numbers now, re-run before tagging the next release, and
investigate any >25% drop. See [`benchmarks/README.md`](../benchmarks/README.md)
for the full methodology.

---

## Breaking changes

**None for v0.9 users.** v1.0 is fully backward compatible.

For users coming from earlier v0.x releases, the only "breaking" changes
introduced in those earlier releases (not v1.0) were additive — every one of
them preserved the previous behavior when the new optional field/policy/flag
was omitted. If you're on v0.4 or later, you have no breaking changes to
absorb for v1.0.

If you're on v0.3 or earlier (which is unlikely given that v0.9 is the latest
prerelease), refer to the per-release "Backward compatibility" notes in
[`CHANGELOG.md`](../CHANGELOG.md) — every release since v0.1 has preserved
backward compatibility with the prior release.

---

## What to do if you imported from `@/lib/db`

### You almost certainly didn't.

The library never re-exports anything from `@/lib/db`. The Prisma client is
loaded dynamically, locally, inside `src/autonomous/stateStore.ts` and
`src/autonomous/logger.ts` — never leaked through the barrel export. If you
were importing from `goose-autonomous-sessions`, you were never touching
`@/lib/db` indirectly.

To check, grep your codebase for direct imports from the package:

```bash
rg "from 'goose-autonomous-sessions'" --type ts
rg "from '\.\./src/autonomous'" --type ts   # if you vendored the source
```

If those are the only imports of the library, you have zero `@/lib/db`
coupling.

### If you imported `prismaStateStore` or `prismaLogger` directly

These are the **only** exports that touch `@/lib/db`, and they're marked
`@experimental` in [`docs/STABILITY.md`](./STABILITY.md). They are reference
adapters intended for Next.js hosts that already have a Prisma client at
`@/lib/db`. They were always lazy; v1.0 just makes that explicit.

If you use them, your code looks like this:

```ts
import { AutonomousSessionController, prismaStateStore, prismaLogger } from 'goose-autonomous-sessions';

const controller = new AutonomousSessionController({
  store: prismaStateStore,
  logger: prismaLogger,
  generateHandoffResponse,
  sendPrompt,
});
```

Under v1.0, this code:

- **Loads successfully** even if `@/lib/db` doesn't exist (the dynamic import is
  deferred until a method is called).
- **Throws a clear error** the first time you call a method, with the message:
  `"Prisma is not configured. This stateStore is a reference adapter — use it
  only in hosts with Prisma. For standalone use, inject your own
  StateStoreAdapter (see examples/in-memory-adapters.ts)."`
- **Works unchanged** in hosts that do have `@/lib/db` configured.

No action required.

### If you built your own adapter

If you implemented your own `StateStoreAdapter` or `LoggerAdapter` (the
recommended path for Goose Desktop / Electron hosts — see
[`adapters/electron-state-store.ts`](../adapters/electron-state-store.ts) for
a reference), you have zero `@/lib/db` coupling by construction. v1.0 changes
nothing for you.

---

## How to know if you're affected

You're affected by v1.0 **only if** all of the following are true:

1. You were calling an export that was renamed, removed, or had its signature
   changed.
2. **No v0.9 export was renamed, removed, or had its signature changed in
   v1.0** — so this is impossible.

Concretely, the rule of thumb is:

> **If your code imported from the barrel export and worked under v0.9, it
> still works under v1.0. No code changes required.**

To verify, after upgrading, run:

```bash
# 1. Re-install the dependency (or re-pull the source).
bun install   # or: git pull && bun install

# 2. Type-check your code.
bun run typecheck   # or: tsc --noEmit

# 3. Run the API stability contract test.
bun test tests/api-stability.test.ts

# 4. Run your own tests.
bun test
```

If steps 2–4 all pass, your code is v1.0-compatible. That's the whole
verification flow.

---

## New features in v1.0

v1.0 is a **stability release** — it ships no new runtime features. The
"new in v1.0" list is short:

| New | What it is | Who it's for |
|-----|------------|--------------|
| `docs/STABILITY.md` | The frozen API surface contract — every export marked `@stable` or `@experimental`, with stability rules | Host authors, downstream consumers |
| `tests/api-stability.test.ts` | A contract test asserting all frozen exports exist + behave correctly | CI / every release |
| `benchmarks/bench.ts` | A perf benchmark suite for the five hot paths | Release maintainers; anyone investigating a perf regression |
| `benchmarks/README.md` | Methodology + how to interpret results | Release maintainers |
| `docs/MIGRATION.md` | This file | Anyone upgrading |

If you were hoping for v1.0 to ship a new feature (e.g., a new rollover policy
dimension, a new webhook event, a new controller method) — it doesn't. v1.0
is the line in the sand: **from here on, the API is stable.** New features
land in v1.1, v1.2, etc. as additive-only changes.

---

## How to verify your code is v1.0-compatible

### Step 1 — Run the API stability test

```bash
bun test tests/api-stability.test.ts
```

This test imports every frozen export from `src/autonomous` and asserts it
exists with the right shape. If your host code only uses frozen exports and
this test passes, your code is v1.0-compatible.

If it fails, the failure message will tell you exactly which export is missing
or mis-shaped — that's a v1.0 release blocker, not something you need to fix
in your host code.

### Step 2 — Type-check your code

```bash
bun run typecheck
# or, in a non-Bun host:
tsc --noEmit
```

v1.0's type definitions are unchanged from v0.9. If your code type-checks
against v0.9, it type-checks against v1.0.

### Step 3 — Run your tests

```bash
bun test
```

### Step 4 (optional) — Capture a benchmark baseline

```bash
bun benchmarks/bench.ts | tee benchmarks/baseline.txt
```

This gives you a number to compare against on future upgrades. Not required,
but useful if you want to detect performance regressions early.

---

## Deprecation notices

**None.** v1.0 deprecates no exports.

The `@experimental` exports in [`docs/STABILITY.md`](./STABILITY.md) —
`prismaStateStore`, `prismaLogger`, and `log` — are NOT deprecated. They are
marked `@experimental` to signal that their **shape** may change in a minor
release (e.g., a future v1.x might add a new optional method to the
`LoggerAdapter` interface, or reorganize the `log` convenience object). They
remain available, supported, and used by the reference Next.js host.

If a future v1.x release does mark something `@deprecated`, the deprecation
will:

1. Add a `@deprecated` JSDoc tag to the export.
2. Document the migration path in the changelog.
3. Keep the export functional for at least one full major release cycle
   (i.e., it would not be removed until v2.0 at the earliest).

---

## Future upgrade path (v1.x and v2.0)

### v1.x — additive only

Every v1.x release (v1.1, v1.2, …) will be **strictly additive**:

- New optional exports (functions, classes, types).
- New optional fields on existing types (always optional, always with sensible
  defaults — never required).
- New optional parameters on existing functions (always appended, always with
  default values).
- New webhook event types (added to the `WebhookEvent` union — additive).
- New `RolloverReason` values (added to the union — additive).
- New `AutonomousPhase` values (added to the union — additive, but rare).

What v1.x will **never** do:

- Remove or rename an existing export.
- Change a function's parameter order or make an optional parameter required.
- Narrow an existing type (e.g., `string` → `string & SomethingElse`).
- Change the exact-line format of a marker string
  (`AUTONOMOUS_STATUS: COMPLETE`, etc.).
- Change an IPC channel name (`autonomous:get-state`, etc.).
- Bump `AUTONOMOUS_SCHEMA_VERSION` without a major release.

To verify each v1.x upgrade is safe, run the API stability test before and
after the bump. If it passes both times, you're safe.

### v2.0 — breaking changes (someday, not soon)

v2.0 is reserved for breaking changes. We have no current plans for a v2.0 —
v1.0 is meant to be the long-term-stable line. If a v2.0 ever happens, it will:

- Be preceded by at least one v1.x release that deprecates the soon-to-break
  exports with `@deprecated` JSDoc tags and migration paths.
- Ship with a v2.0 migration guide (much like this one) that walks through
  every breaking change with a before/after code diff.
- Preserve the v1.x line in maintenance mode for at least 6 months after v2.0
  ships.

Candidate things that **could** become breaking changes in a hypothetical v2.0
(this is a forecast, not a commitment):

- Removing `prismaStateStore` / `prismaLogger` (the `@experimental` reference
  adapters) if the ecosystem has converged on better patterns.
- Renaming `rolloverThreshold` to `contextPercent` on `AutonomousSettings` to
  match the canonical `RolloverPolicy` field name.
- Bumping `AUTONOMOUS_SCHEMA_VERSION` to `2` if the run record needs a
  fundamental shape change (e.g., multi-run support).

None of these are planned. They're listed here so you can plan your own
coupling accordingly — if you want to insulate yourself from a future v2.0,
prefer the `@stable` exports over the `@experimental` ones, and prefer the
canonical `RolloverPolicy` field over the legacy `rolloverThreshold` shortcut.

---

## Getting help

- **Stability contract**: [`docs/STABILITY.md`](./STABILITY.md) — the source of
  truth for what is and isn't frozen.
- **Per-release changes**: [`CHANGELOG.md`](../CHANGELOG.md) — every release
  since v0.1, with explicit "Backward compatibility" sections.
- **Bug reports / questions**: [GitHub Issues](https://github.com/dentLogic/goose-autonomous-sessions/issues).
- **Contributing**: [`CONTRIBUTING.md`](../CONTRIBUTING.md).

If you hit something this guide doesn't cover, please open an issue —
migration paths that aren't documented are bugs in the docs.
