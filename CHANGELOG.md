# Changelog

All notable changes to `goose-autonomous-sessions` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2025-01-24

### 🎉 The stable release

v1.0 freezes the public API surface. From this point forward, changes follow
Semantic Versioning: patches fix bugs, minors add (backward-compatible) features,
and majors break the frozen API.

### Added — API stability + benchmarks + migration guide

- **API stability freeze** (`docs/STABILITY.md`):
  - Documents every frozen export with its `@stable` / `@experimental` status
  - Covers: 23 types, 1 controller class + 7 methods, 30+ functions, 11 constants
  - Backward compatibility guarantees: optional fields stay optional, no signature changes, type narrowing only, marker regexes frozen
  - Deprecation policy: deprecated exports survive at least one major cycle

- **API stability test** (`tests/api-stability.test.ts` — 24 tests):
  - Verifies every documented export exists with the correct type
  - Verifies marker strings are frozen (`AUTONOMOUS_STATUS: COMPLETE` etc.)
  - Verifies IPC channel names are frozen
  - Verifies function signatures (parameter count, return types)
  - This test is a **contract**: if it fails, a frozen export was removed/renamed → breaking change

- **Performance benchmarks** (`benchmarks/`):
  - `benchmarks/bench.ts` — 5 benchmarks measuring hot paths
  - `benchmarks/README.md` — methodology + how to interpret results
  - Measured: controller throughput (400K ops/sec), handoff validation (1.25M), policy evaluation (1.43M), serialization (208K), HMAC signing (714K)
  - Run with: `bun benchmarks/bench.ts`

- **Migration guide** (`docs/MIGRATION.md`):
  - v0.x → v1.0 migration guide (spoiler: no breaking changes)
  - Documents the lazy Prisma loading change
  - 4-step verification flow (run stability test → typecheck → run tests → capture baseline)
  - Future upgrade path (v1.x strictly additive, v2.0 reserved for breaking changes)

### Changed

- `src/autonomous/stateStore.ts` — Prisma import is now **lazy** (`getDb()` async loader). The module loads without Prisma installed — the portable core has zero hard deps. Only `prismaStateStore`/`prismaLogger` (the reference adapters) trigger the Prisma import, and only when called.
- `src/autonomous/logger.ts` — same lazy Prisma loading fix
- `package.json` — v1.0.0; added `cli` script (v0.9)

### Backward compatibility

- **v1.0 is fully backward compatible with v0.9.** All 167 v0.9 tests pass unchanged.
- The lazy Prisma change is invisible to existing hosts: if you were using `prismaStateStore`, it still works — the import is just deferred from module-load to first-call.
- No function signatures changed. No types narrowed. No constants renamed.

### Test suite

- **191 tests, all passing** (167 from v0.9 + 24 new API stability tests)
- Ran in ~20.5s
- API stability test: 24/24 pass — the frozen surface is verified

### What "stable" means

1. The public API (documented in `docs/STABILITY.md`) is frozen
2. Breaking changes require a major version bump (v2.0.0)
3. Minor releases (v1.x) are strictly additive
4. Patch releases (v1.0.x) fix bugs only
5. The API stability test (`tests/api-stability.test.ts`) is the contract enforcer

### Intentionally not in v1.0

- macOS / Windows support (Linux-first by user request)
- Actual npm publication (requires `NPM_TOKEN` secret — workflow is ready)

## [0.9.0] — 2025-01-23

### Added — jitter + replay + CLI

- **Webhook retry jitter** (`WebhookRetryPolicy.jitter`):
  - When `jitter: true`, a random 0–50% of the computed backoff delay is added
  - Prevents the "thundering herd" problem when multiple webhooks retry simultaneously
  - Works with both `'fixed'` and `'exponential'` backoff strategies
  - Default: `false` (backward compatible with v0.8)

- **Webhook event replay** (`replayFailedDeliveries()`):
  - Re-delivers failed webhook deliveries from the delivery log
  - Failed records now store the original `payload` + `config` (url, secret, retry)
  - `replayFailedDeliveries(logger, runId?)` — re-attempts all failed deliveries (optionally filtered by runId)
  - `getReplayableDeliveries(runId?)` — inspect which deliveries are eligible for replay
  - Original records are preserved; new records are appended for replay attempts
  - Dashboard endpoint: `POST /api/webhooks/replay?runId=xxx`

- **CLI tool** (`cli/goose-autonomous.ts`):
  - Terminal inspector for autonomous-session state — no browser required
  - Commands: `state`, `logs`, `webhooks`, `sessions`, `metrics`, `replay`, `help`
  - Flags: `--data-dir DIR`, `--limit N`, `--run-id ID`
  - Run with: `bun cli/goose-autonomous.ts <command>`
  - Read-only (except `replay` which re-attempts failed deliveries)

- **v0.9 demo** (`examples/v0.9-demo.ts`):
  - Demonstrates jitter (comparing with/without) + event replay
  - Shows failed deliveries being replayed with new records appended

- **9 new tests** (167 total):
  - `tests/v0.9-integration.test.ts` — jitter (3: disabled by default, adds randomness, works with exponential), replay (6: stores payload+config, getReplayableDeliveries, replayFailedDeliveries re-attempts, filters by runId, returns 0 when no failures, delivered records don't store payload)

### Changed

- `src/autonomous/types.ts` — added `jitter` to `WebhookRetryPolicy`; added `payload` + `config` fields to `WebhookDeliveryRecord`
- `src/autonomous/webhooks.ts` — `deliverWithRetry` applies jitter when enabled; failed deliveries now store payload + config; added `replayFailedDeliveries()` + `getReplayableDeliveries()` exports
- `dashboard/server.ts` — added `POST /api/webhooks/replay` endpoint
- `package.json` — v0.9.0; added `cli` script; added `bin` field for the CLI
- `examples/` — added `v0.9-demo.ts`
- `cli/` — new directory with `goose-autonomous.ts`

### Backward compatibility

- v0.8 `WebhookRetryPolicy` without `jitter` → jitter disabled (default)
- v0.8 `WebhookDeliveryRecord` without `payload`/`config` → still valid (only failed deliveries store them)
- All 158 v0.8 tests pass unchanged

### Test suite

- **167 tests, all passing** (158 from v0.8 + 9 new)
- Ran in ~20.5s (slower due to jitter + replay timing tests)

### Intentionally not in v0.9

- macOS / Windows support (Linux-first by user request)
- Actual npm publication (requires `NPM_TOKEN` secret — workflow is ready)

## [0.8.0] — 2025-01-22

### Added — configurable retry + webhook dashboard + npm-ready

- **Configurable webhook retry policy** (`WebhookConfig.retry`):
  - Per-webhook `WebhookRetryPolicy`: `{ maxAttempts?, backoffMs?, backoffStrategy? }`
  - `maxAttempts`: total delivery attempts (default 2; 1 = no retry, 3 = two retries)
  - `backoffMs`: delay between retries (default 2000ms)
  - `backoffStrategy`: `'fixed'` (constant) or `'exponential'` (delay doubles each retry; default `'fixed'`)
  - Different webhooks can have different policies
  - Backward compatible: omit `retry` → v0.6/v0.7 behavior (2 attempts, 2s fixed delay)

- **Webhook delivery dashboard endpoint** (`/api/webhooks`):
  - `GET /api/webhooks?limit=100&runId=xxx` — recent delivery records + summary stats
  - `DELETE /api/webhooks` — clear the delivery log
  - Summary: `{ total, delivered, failed, skipped, signed }`
  - Protected by the dashboard's Bearer auth (if `AUTONOMOUS_DASHBOARD_TOKEN` is set)

- **npm publication readiness**:
  - Package metadata finalized (author email, expanded keywords, 3 export paths)
  - Name `goose-autonomous-sessions` confirmed available on npm
  - `prepublishOnly` runs tests + typecheck before publish
  - The `.github/workflows/publish.yml` workflow auto-publishes on `v*` tag when `NPM_TOKEN` is set

- **v0.8 demo** (`examples/v0.8-demo.ts`):
  - Demonstrates 3 webhooks with different retry policies (default, no-retry, exponential)
  - Shows the delivery log capturing each policy's behavior

- **10 new tests** (158 total):
  - `tests/v0.8-integration.test.ts` — retry policy (6 tests: default, maxAttempts=1/3, custom backoffMs, exponential, per-webhook), delivery log shape (1), signPayload/verifySignature (3)

### Changed

- `src/autonomous/types.ts` — added `WebhookRetryPolicy` type, added `retry` field to `WebhookConfig`
- `src/autonomous/webhooks.ts` — `deliverWithRetry` now reads the retry policy (maxAttempts, backoffMs, backoffStrategy); supports exponential backoff
- `dashboard/server.ts` — added `/api/webhooks` GET + DELETE endpoint; imported `getDeliveryLog` + `clearDeliveryLog`
- `package.json` — v0.8.0; expanded keywords; added `./webhooks` export path; added author email
- `examples/` — added `v0.8-demo.ts`

### Backward compatibility

- v0.7 `WebhookConfig` without `retry` → uses default (2 attempts, 2s fixed)
- All 148 v0.7 tests pass unchanged

### Test suite

- **158 tests, all passing** (148 from v0.7 + 10 new)
- Ran in ~14.7s (slower due to retry backoff timeouts)

### Intentionally not in v0.8

- macOS / Windows support (Linux-first by user request)
- Actual npm publication (requires `NPM_TOKEN` secret — workflow is ready)

## [0.7.0] — 2025-01-21

### Added — webhook security + filtering + observability

- **HMAC-SHA256 payload signing** (`WebhookConfig.secret`):
  - When a webhook has a `secret`, every delivery is signed
  - Signature sent in the `X-Goose-Autonomous-Signature: sha256=<hex>` header
  - Receivers verify with the exported `verifySignature(secret, body, signature)` helper
  - Uses timing-safe comparison to prevent timing attacks
  - `signPayload(secret, body)` also exported for testing/custom use

- **Per-event webhook filtering** (`WebhookConfig.events`):
  - Each webhook can specify an allowlist of event types
  - Events not in the list are skipped (recorded as `skipped` in the delivery log)
  - Omit `events` to receive ALL events (backward compatible)

- **Webhook delivery log**:
  - Every delivery attempt is recorded (delivered / failed / skipped)
  - `getDeliveryLog(limit?, runId?)` — query the log (newest first)
  - `clearDeliveryLog()` — reset (for tests)
  - Capped at 500 records (most recent kept)
  - Each record: `{ id, url, event, runId, attemptedAt, status?, result, error?, signed, attempt }`
  - Available on the `WebhookDeliveryRecord` type

- **WebhookConfig type** — replaces plain string URLs with structured config:
  ```ts
  webhooks: [
    { url: 'https://slack.com/...', events: ['run.completed', 'run.failed'], secret: 's3cret' },
    { url: 'https://monitor.com/...', events: ['budget.exhausted'] },
    'https://simple.com/all-events', // backward-compat string form still works
  ]
  ```

- **v0.7 demo** (`examples/v0.7-demo.ts`):
  - Demonstrates HMAC sign + verify, event filtering, delivery log inspection
  - Shows receiver-side signature verification

- **20 new tests** (148 total):
  - `tests/v0.7-integration.test.ts` — normalizeWebhooks (3), HMAC signing (7), event filtering (4), delivery log (6)

### Changed

- `src/autonomous/types.ts` — `webhooks` field now accepts `string[] | WebhookConfig[]`; added `WebhookConfig`, `WebhookDeliveryRecord` types
- `src/autonomous/webhooks.ts` — rewrote to support HMAC signing, event filtering, delivery log; exported `signPayload`, `verifySignature`, `normalizeWebhooks`, `getDeliveryLog`, `clearDeliveryLog`
- `examples/` — added `v0.7-demo.ts`

### Backward compatibility

- v0.6 `webhooks: string[]` still works (normalized to `WebhookConfig[]` with no events filter + no secret)
- All 128 v0.6 tests pass unchanged

### Test suite

- **148 tests, all passing** (128 from v0.6 + 20 new)
- Ran in ~6.7s (slower due to webhook retry timeouts)

### Intentionally not in v0.7

- macOS / Windows support (Linux-first by user request)
- npm package publication (workflow ready — add `NPM_TOKEN` secret)

## [0.6.0] — 2025-01-20

### Added — cost budget + webhooks

- **Cost-based run budget** (`AutonomousSettings.maxTotalCostCents`):
  - A hard run-wide budget that halts the entire run when `totalCostCents` exceeds the limit
  - Distinct from `rolloverPolicy.maxCostCentsPerSession` (which is per-session and triggers rollover, not halt)
  - Enforced in `onTurnFinished` after cost accumulation, before completion/rollover checks
  - Emits a `budget.exhausted` webhook + sets `lastError`
  - `0` / `undefined` = unlimited (v0.1–v0.5 behavior — backward compatible)

- **Webhook notifications** (`AutonomousSettings.webhooks`):
  - Fire-and-forget POST delivery to configured URLs on run events
  - 10 event types: `run.started`, `run.completed`, `run.failed`, `run.stopped`, `run.resumed`, `rollover.completed`, `verification.started`, `verification.passed`, `verification.failed`, `budget.exhausted`
  - Retries once on network failure (after 2s)
  - 5s timeout per attempt
  - Payload includes a compact run snapshot + event-specific details
  - `WebhookPayload` type: `{ event, runId, emittedAt, run, details }`
  - Injectable via `ControllerDeps.webhookNotifier` (for testing or queue-based delivery)
  - No-op when no webhooks configured (backward compatible)

- **v0.6 demo** (`examples/v0.6-demo.ts`):
  - Demonstrates cost budget halting a run + webhook event capture
  - Watch the budget exhaust + `budget.exhausted` webhook fire

- **12 new tests** (128 total):
  - `tests/v0.6-integration.test.ts` — cost budget (3 tests) + webhooks (9 tests covering all event types)

### Changed

- `src/autonomous/types.ts` — added `maxTotalCostCents` + `webhooks` to `AutonomousSettings`; added `WebhookEvent` + `WebhookPayload` types
- `src/autonomous/webhooks.ts` — new module: `createWebhookNotifier()`, `buildRunSnapshot()`, `deliverWithRetry()`
- `src/autonomous/controller.ts` — `checkCostBudget()` method; `emitWebhook()` method; webhook emissions at all 10 event points (startRun, stopRun, resumeRun, performRollover, handleWorkerComplete, handleVerificationPass/Fail, budget/handoff failures)
- `src/autonomous/index.ts` — exports the new `webhooks` module
- `examples/` — added `v0.6-demo.ts`

### Test suite

- **128 tests, all passing** (116 from v0.5 + 12 new)
- Ran in ~236ms

### Intentionally not in v0.6

- macOS / Windows support (Linux-first by user request)
- npm package publication (workflow ready — add `NPM_TOKEN` secret)

## [0.5.0] — 2025-01-19

### Added — cost tracking + run resume + production dashboard

- **Cost-based rollover policy** (`RolloverPolicy.maxCostCentsPerSession`):
  - 4th rollover dimension: roll over when the estimated token cost of a session exceeds a budget
  - The controller tracks `sessionCostCents` (per-session, resets on rollover) + `totalCostCents` (run-total, never resets)
  - The host reports per-turn cost via `AgentTurn.costCents`
  - Priority when multiple policies trip: `context > turns > time > cost`
  - Backward compatible: if `maxCostCentsPerSession` is omitted, no cost tracking occurs

- **Run resume** (`controller.resumeRun()`):
  - Fills the spec §44 gap: "A stopped run should not automatically resume. The user must explicitly start/resume it."
  - `stopRun()` now preserves the pre-stop phase in `phaseBeforeStop`
  - `resumeRun()` restores the run to `active` + the phase it was in when stopped
  - If stopped mid-rollover (`handoff` / `creating-session`), resumes in `working` with rollover re-pending
  - Throws if the run isn't in `stopped` status
  - Preserves handoff, session lineage, and logs across stop/resume
  - Resets `currentSessionStartedAt` so time-based policies don't immediately trip

- **Dashboard hardening** (`dashboard/server.ts`):
  - **Bearer token auth**: set `AUTONOMOUS_DASHBOARD_TOKEN` to require auth on all endpoints
  - **`/api/metrics`** endpoint: compact Prometheus-friendly JSON (active/completed/stopped/errored flags, worker_generation, verification_attempt, context_usage_pct, session_cost_cents, total_cost_cents, phase, etc.)
  - **`/api/export`** endpoint: full run data as downloadable JSON (with `Content-Disposition` header)
  - **`/api/health`** endpoint: `{ ok, uptime, dataDir }` for load balancers / process managers
  - Auth works via both `Authorization: Bearer <token>` header and `?token=` query param

- **17 new tests** (116 total):
  - `tests/rollover-policy.test.ts` — 7 new cost-policy tests (trips at/above/below budget, disabled, undefined cost, combined priority)
  - `tests/v0.5-integration.test.ts` — 10 new controller integration tests (cost rollover, cost accumulation, resume from stopped, resume from verifying, resume preserves state, resume + complete)

### Changed

- `src/autonomous/types.ts` — added `maxCostCentsPerSession` to `RolloverPolicy`, `cost` to `RolloverReason`, `sessionCostCents` + `totalCostCents` + `phaseBeforeStop` to `AutonomousRun`, `costCents` to `AgentTurn`
- `src/autonomous/rollover-policy.ts` — `evaluateRollover` now evaluates the cost policy (priority 4); `resolvePolicy` propagates `maxCostCentsPerSession`
- `src/autonomous/controller.ts` — `onTurnFinished` accumulates `turn.costCents` into session + total cost; `onContextUsage` + `onTurnFinished` pass `sessionCostCents` to the evaluator; `stopRun` preserves `phaseBeforeStop`; `resumeRun` method added; `sessionCostCents` reset on every rollover
- `dashboard/server.ts` — auth middleware + 3 new endpoints (`/api/metrics`, `/api/export`, `/api/health`)
- `dashboard/README.md` — documented auth + all endpoints with examples

### Test suite

- **116 tests, all passing** (99 from v0.4 + 17 new)
- Ran in ~45ms

### Intentionally not in v0.5

- macOS / Windows support (Linux-first by user request)
- npm package publication (workflow ready — add `NPM_TOKEN` secret)

## [0.4.0] — 2025-01-18

### Added — safety valves + rollover policies + npm readiness

- **Verification retry budget** (`AutonomousSettings.maxVerificationAttempts`):
  - Optional max on verification attempts. When the budget is exhausted, the run enters a controlled `error` state instead of looping forever.
  - `0` / `undefined` = unlimited (v0.1–v0.3 behavior — backward compatible).
  - Enforced in `handleWorkerComplete` BEFORE generating a final handoff (so a budget-exhausted run doesn't waste an LLM call).
  - `verificationBudgetExceeded()` exposed from `rollover-policy.ts` for testing.

- **Configurable rollover policy** (`AutonomousSettings.rolloverPolicy`):
  - `RolloverPolicy` type with three optional fields, combined with OR semantics:
    - `contextPercent` (0..1) — the v0.1–v0.3 behavior, now composable
    - `maxTurnsPerSession` — roll over after N worker turns (regardless of context %)
    - `maxMinutesPerSession` — roll over after N minutes (time-based)
  - `rollover-policy.ts` module with pure functions: `resolvePolicy()`, `evaluateRollover()`, `verificationBudgetExceeded()`
  - Priority order when multiple trip: context > turns > time
  - The controller tracks `turnsInCurrentSession` + `currentSessionStartedAt` + `rolloverReason` on the run record
  - Backward compatible: if `rolloverPolicy` is omitted, the controller uses the legacy `rolloverThreshold` for context-only rollover

- **`ControllerDeps.settings` override** (v0.4):
  - Hosts can now inject settings via `ControllerDeps.settings` that override the run-time settings
  - Useful for changing the rollover policy or verification budget mid-run without restarting

- **npm publication readiness**:
  - `.npmignore` — excludes tests, CI, dashboard, patches, docs from the npm tarball
  - `package.json` `files` field tightened to ship only `src/autonomous/`, `examples/`, `adapters/`, README, LICENSE
  - `prepublishOnly` script — runs tests + typecheck before npm publish
  - `prepack` script — verifies npm pack contents

- **v0.4 demo** (`examples/v0.4-demo.ts`):
  - Demonstrates turn-based rollover (every 2 turns) + verification budget (max 2)
  - Shows the run halting cleanly when the budget is exhausted

- **31 new tests** (99 total):
  - `tests/rollover-policy.test.ts` (22 tests) — pure-function tests for `resolvePolicy`, `evaluateRollover` (context/turns/time/combined), `verificationBudgetExceeded`
  - `tests/v0.4-integration.test.ts` (9 tests) — controller integration: budget halts, turn-based rollover, per-session tracking resets

### Changed

- `src/autonomous/types.ts` — added `RolloverPolicy`, `RolloverReason`, extended `AutonomousRun` (turns/time tracking) + `AutonomousSettings` (budget + policy)
- `src/autonomous/controller.ts` — `onContextUsage` + `onTurnFinished` now evaluate the full policy; `handleWorkerComplete` enforces the budget; per-session tracking resets on every rollover
- `src/autonomous/index.ts` — exports the new `rollover-policy` module
- `package.json` — v0.4.0; added `prepublishOnly` + `prepack` scripts
- `examples/` — added `v0.4-demo.ts`

### Test suite

- **99 tests, all passing** (68 from v0.3 + 31 new)
- Ran in ~43ms

### Intentionally not in v0.4

- macOS / Windows support (Linux-first by user request)
- Web dashboard with auth (the monitor is local-only, read-only)

## [0.3.0] — 2025-01-17

### Added — configurability + observability + CI

- **Configurable handoff schema** (`src/autonomous/handoff-schema.ts`):
  - `HandoffField` type with `name`, `type` (`string` | `string[]` | `test[]`), `required`, `description`, `maxLen`, `maxItems`, `itemMax`, `label`
  - `HandoffSchema` = array of fields
  - `defaultHandoffSchema()` returns the 9 built-in fields (backward compatible)
  - `createHandoffSchema(base, extensions)` — extends the default with custom fields (extensions override built-ins with the same name)
  - `buildHandoffPromptFromSchema(objective, schema)` — generates a schema-aware prompt
  - `validateHandoffAgainstSchema(handoff, schema)` — schema-aware validation
  - `serializeHandoffWithSchema(handoff, schema)` — schema-aware compact text serialization
  - `parseHandoffResponseWithSchema(raw, schema)` — fence-tolerant schema-aware parsing
  - `coerceToHandoff(parsed, objective)` — extracts built-in fields from a custom-schema handoff
  - `ControllerDeps.handoffSchema` — optional; if omitted, uses the default (backward compatible)
  - The controller's `generateValidatedHandoff` + prompt builders use the schema when provided

- **Standalone monitoring dashboard** (`dashboard/`):
  - `dashboard/server.ts` — a zero-dependency Bun server that reads the JSON state files written by the Electron adapter and serves a live dashboard
  - Live auto-refresh (1s polling) + instant updates via Server-Sent Events (SSE)
  - State panel, context gauge with threshold marker, handoff viewer, session timeline, streaming event log
  - Runs alongside Goose Desktop — monitor from any browser (or via SSH tunnel from another machine)
  - `bun dashboard/server.ts` → `http://localhost:7878`

- **CI workflow** (`.github/workflows/ci.yml`):
  - Runs on every push/PR to main
  - Steps: checkout → setup Bun → install → `bun test` → `tsc --noEmit` → standalone demo smoke test
  - Bonus job: clones Goose at the pinned commit + validates all patches

- **npm publish workflow** (`.github/workflows/publish.yml`):
  - Triggers on `v*` tag push
  - Runs tests + typecheck + `npm pack --dry-run` verification
  - Publishes to npm if `NPM_TOKEN` secret is set (skips gracefully if not)

- **22 new schema tests** (`tests/handoff-schema.test.ts`):
  - default schema (9 fields, backward compat)
  - custom field extension (required/optional, type checking, size limits)
  - field override (same-name extension replaces built-in)
  - schema-aware prompt builder, serializer, parser
  - `coerceToHandoff` extraction

### Changed

- `src/autonomous/controller.ts` now imports + uses the handoff-schema module; `ControllerDeps` accepts an optional `handoffSchema`
- `src/autonomous/index.ts` exports the new `handoff-schema` module
- `package.json` bumped to 0.3.0; added `test`, `dashboard` scripts
- `tsconfig.json` includes `tests` dir

### Test suite

- **68 tests, all passing** (46 from v0.2 + 22 new schema tests)
- Ran in ~38ms

### Intentionally not in v0.3

- macOS / Windows support (explicitly deferred — Linux-first by user request)
- npm package publication (workflow is ready; publish when `NPM_TOKEN` is configured)
- Verification retry budget
- Web dashboard with auth (the monitor is read-only + local-only)

## [0.2.0] — 2025-01-16

### Added — Goose Desktop integration

- **Pinned Goose commit** (`patches/PINNED_COMMIT`): `ce0c4900837a51b2ae50ce0df1484c34a1be754e`.
  The installer now verifies the Goose source matches this commit (or warns + asks before proceeding).
- **5 validated lifecycle patches** (`patches/*.patch`) generated against the real pinned Goose source:
  - `0001-add-autonomous-event.patch` — adds `GOOSE_AUTONOMOUS_SWITCH_SESSION` to `constants/events.ts`
  - `0002-add-settings-field.patch` — adds `AutonomousSettings` to `utils/settings.ts`
  - `0003-wire-useChatSession.patch` — hooks `onContextUsage` + `onTurnFinished` into `useChatSession.ts`
  - `0004-wire-navigation.patch` — handles the session-switch event in `useNavigationSessions.ts`
  - `0005-add-electron-ipc.patch` — registers `StateStore` IPC handlers in `main.ts` + exposes them in `preload.ts`
- **Patch validation script** (`patches/validate.sh`) — verifies the pinned commit + dry-runs every patch before applying.
- **Patch series file** (`patches/SERIES`) — documents the apply order.
- **Electron main-process adapters** (`adapters/`):
  - `electron-state-store.ts` — `StateStoreAdapter` backed by atomic JSON files in `app.getPath('userData')` (tmp → fsync → rename)
  - `electron-logger.ts` — `LoggerAdapter` backed by batched + rotated `autonomous.log.jsonl`
  - `acp-integration.ts` — the two ACP-backed strategies (`acpHandoffGenerator` + `acpSendPrompt`) calling Goose's real `acpPromptSession` / `acpNewSession`
  - `electron-ipc-handlers.ts` — `ipcMain.handle` registrations for the renderer↔main bridge
- **Automated installer** (`install.sh` v0.2):
  - Validates the pinned commit (warns + asks if mismatched)
  - Validates all patches before applying (aborts cleanly if any fail)
  - Copies `src/autonomous/` + `adapters/` into `ui/desktop/src/`
  - Auto-generates the controller singleton (`src/autonomous/index.ts`) wired to the Electron + ACP adapters
  - Applies all patches in series order
  - Optional `--build` flag runs `pnpm install && pnpm build` in `ui/desktop/`
- **Test suite** (46 tests, all passing):
  - `tests/state-machine.test.ts` — basic transitions, rollover, verification, duplicate prevention, stop semantics
  - `tests/handoff.test.ts` — prompt builder, validation (8 cases), JSON parsing (fence-tolerant), serialization, objective stamping
  - `tests/completion-detection.test.ts` — exact-line marker matching, malformed markers, natural-language rejection
  - `tests/recovery.test.ts` — the full spec-36 decision tree (9 phases)

### Changed

- `install.sh` upgraded from v0.1 (copy-only) to v0.2 (validate → copy → patch → optional build).
- `patches/README.md` rewritten with the pinned commit, the real integration points, and the deviations discovered in the actual Goose source.
- `README.md` updated with v0.2 install instructions, the adapter architecture diagram, and the test suite.

### Intentionally not in v0.2

- macOS / Windows support (still Linux-first).
- Configurable handoff schema (custom fields).
- Verification retry budget.
- npm package publication (clone-and-install for now).

## [0.1.0] — 2025-01-15

### Added

- **Portable autonomous-session controller** (`src/autonomous/`) with zero hard
  dependencies on any persistence layer or host runtime. Persistence and logging
  are injected as `StateStoreAdapter` + `LoggerAdapter`.
- **State machine** with explicit phases: `working` → `handoff` → `creating-session`
  → `verifying` → `completed` (with `error` / `stopped` terminal states).
- **Context rollover** — marks rollover pending at the configured threshold
  (default 75 %) without interrupting the current turn; generates a structured
  handoff after the turn finishes; creates a completely fresh session.
- **Structured handoff format** — machine-readable JSON with strict validation
  (objective, current state, completed/remaining work, files changed, tests,
  failures, decisions, constraints, exact next action).
- **Completion detection** via exact-line markers
  (`AUTONOMOUS_STATUS: COMPLETE` / `CONTINUE`).
- **Independent verification** — a fresh verifier session inspects the repo
  itself and emits `AUTONOMOUS_VERIFICATION: PASS` / `FAIL`. On FAIL, the
  verifier's findings become the next handoff and a new worker is spun up.
- **Crash recovery** — the persisted run record + handoff survive crashes;
  recovery never guesses and uses `pendingSessionId` for idempotent transitions.
- **Serialized transition queue** — prevents double-rollover from concurrent
  context/turn-finish events.
- **In-memory adapters** (`examples/in-memory-adapters.ts`) for zero-dep demos.
- **Standalone demo** (`examples/standalone-demo.ts`) — run with
  `bun examples/standalone-demo.ts`.
- **Installer** (`install.sh`) — safely copies the module into a Goose Desktop
  source checkout with git-branch backup.
- **Uninstaller** (`uninstall.sh`) — restores the pre-installation state.
- **Documentation** — `docs/PRD.md`, `docs/TDD.md`, `docs/IMPLEMENTATION.md`.

### Intentionally not in v0.1

- Goose Desktop lifecycle patches (pending a pinned Goose commit — see
  `patches/README.md`).
- Automated Desktop build step in the installer.
- macOS / Windows support (Linux-first).
