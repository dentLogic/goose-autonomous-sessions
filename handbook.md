<div align="center">

# 🪿 goose-autonomous-sessions — Handbook

### The single definitive reference for the global autonomous-session controller for Goose Desktop.

</div>

---

> **Scope.** This handbook documents every option, label, field, action, event,
> workflow, configuration value, public API method, state transition, marker,
> webhook event, dashboard endpoint, CLI command, install step, and best
> practice supported by `goose-autonomous-sessions` v1.0. It is a reference
> manual, not a tutorial — exhaustive by design.
>
> **Conventions.**
> - Field names are written in `backticks` (e.g. `rolloverThreshold`).
> - Type names are written in `TitleCase` (e.g. `AutonomousSettings`).
> - Literal marker strings are written exactly as the controller matches them
>   (e.g. `AUTONOMOUS_STATUS: COMPLETE`).
> - Version annotations (`v0.4`, `v0.7`, etc.) refer to the version that
>   introduced the feature; they do not gate current behaviour.

---

## Table of contents

- [Part 1 — Concepts](#part-1--concepts)
  - [1.1 What the system does](#11-what-the-system-does)
  - [1.2 The core principle: state continuity, not conversation continuity](#12-the-core-principle-state-continuity-not-conversation-continuity)
  - [1.3 The handoff format](#13-the-handoff-format)
  - [1.4 The state machine](#14-the-state-machine)
- [Part 2 — Configuration Reference](#part-2--configuration-reference)
  - [2.1 `AutonomousSettings`](#21-autonomoussettings)
  - [2.2 `RolloverPolicy`](#22-rolloverpolicy)
  - [2.3 `WebhookConfig`](#23-webhookconfig)
  - [2.4 `WebhookRetryPolicy`](#24-webhookretrypolicy)
  - [2.5 `HandoffSchema` / `HandoffField`](#25-handoffschema--handofffield)
  - [2.6 `ControllerDeps`](#26-controllerdeps)
- [Part 3 — Markers Reference](#part-3--markers-reference)
- [Part 4 — Webhook Events Reference](#part-4--webhook-events-reference)
- [Part 5 — Controller API Reference](#part-5--controller-api-reference)
- [Part 6 — State Machine Reference](#part-6--state-machine-reference)
- [Part 7 — Dashboard Reference](#part-7--dashboard-reference)
- [Part 8 — CLI Reference](#part-8--cli-reference)
- [Part 9 — Install / Uninstall Reference](#part-9--install--uninstall-reference)
- [Part 10 — Workflows & Best Practices](#part-10--workflows--best-practices)
- [Part 11 — Type Reference](#part-11--type-reference)

---

# Part 1 — Concepts

## 1.1 What the system does

`goose-autonomous-sessions` is a **global autonomous-session controller for
Goose Desktop**. It lets you start a long-running development task — one that
would normally overflow a single model context window — and have Goose
automatically roll over from session to session, carrying the work forward,
until the task is complete and independently verified.

In plain English:

1. You give Goose an objective ("Refactor the auth module to use the new
   session API and add tests").
2. The worker session does the work. Each time its context fills up — or it
   hits a turn count, a wall-clock limit, or a cost ceiling — the controller
   pauses the worker, asks it for a structured **handoff** describing exactly
   what was done and what remains, opens a **fresh** session, hands the
   handoff to it, and continues. The previous session is abandoned; the new
   one starts clean.
3. When a worker emits `AUTONOMOUS_STATUS: COMPLETE`, the controller does
   **not** trust the claim. It opens a separate **verification** session,
   hands it the same handoff plus the original objective, and asks it to
   independently inspect the repository and run tests. The verifier emits
   `AUTONOMOUS_VERIFICATION: PASS` or `AUTONOMOUS_VERIFICATION: FAIL`.
4. On `PASS` the run is `completed`. On `FAIL` the verifier's findings become
   the next handoff and a new worker session is spawned to address them.
5. The whole process is fire-and-forget. You can walk away, come back hours
   later, and find either a completed, verified task or a controlled error
   with a full audit trail.

The system is **local-first**. There is no cloud. State lives in JSON files
on disk. The dashboard, CLI, and webhooks all read those files or run in the
same process. Nothing leaves the machine.

The controller is **host-portable**. It depends only on three injected
adapters (`StateStoreAdapter`, `LoggerAdapter`, plus the
`generateHandoffResponse` and `sendPrompt` strategies), so the same code runs
inside Goose Desktop's Electron main process, a Next.js demo app, or a
standalone Bun script with in-memory adapters.

## 1.2 The core principle: state continuity, not conversation continuity

The single most important design decision in this system is:

> **The unit of continuity is the task state — never the conversation.**

A long autonomous run may move through dozens of model sessions. None of
them share a chat history. None of them can see what the previous one said.
What they share is:

1. The **immutable original objective** (set once at `startRun`, never
   changed).
2. The **structured handoff** (the latest snapshot of: what is true now,
   what is done, what is left, what files changed, what tests pass, what
   failed, what was decided, what constraints must hold, and what the next
   action is).
3. The **actual repository state** on disk, which every session is required
   to inspect independently before trusting any handoff claim.

This is the opposite of approaches that try to extend context by
summarizing chat history, compressing messages, or stuffing old turns into a
new prompt. Those approaches leak stale assumptions and let the model trust
its own prior claims. The handoff approach forces every fresh session to
re-ground itself in the real repository.

**Consequences of the principle.**

- The handoff is the **only** inter-session channel. If something is not in
  the handoff, the next session does not know it.
- Handoffs are **validated** before they are accepted. A handoff missing
  required fields, or with fields exceeding length limits, is rejected and
  the controller retries generation once.
- The objective is **stamped** onto every handoff by the controller (via
  `stampObjective`) so a worker can never silently drift the goal.
- Verification is **independent**: the verifier is a brand-new session that
  gets the same objective + handoff but is told explicitly *not* to trust
  the worker's claims.
- Stopping the run does not delete the handoff, sessions, or logs — they
  are the audit trail. Resuming restores state, not chat.

## 1.3 The handoff format

A handoff is a JSON object with ten fields. Nine are produced by the worker
LLM; the tenth (`objective`) is stamped by the controller.

The full TypeScript shape (from `types.ts`):

```ts
interface Handoff {
  objective: string;          // stamped by controller, never from LLM
  currentState: string;       // ≤ 4000 chars
  completedWork: string[];    // ≤ 128 items, each ≤ 1000 chars
  remainingWork: string[];    // ≤ 128 items, each ≤ 1000 chars
  filesChanged: string[];     // ≤ 128 items, each ≤ 1000 chars
  tests: HandoffTest[];       // ≤ 64 items
  failures: string[];         // ≤ 128 items, each ≤ 1000 chars
  decisions: string[];        // ≤ 128 items, each ≤ 1000 chars
  constraints: string[];      // ≤ 128 items, each ≤ 1000 chars
  nextAction: string;         // ≤ 2000 chars
  generatedAt: string;         // ISO timestamp, set by controller
}

interface HandoffTest {
  command?: string;            // e.g. "bun test"
  result: 'PASS' | 'FAIL' | 'UNKNOWN';
  details?: string;
}
```

| Field | Type | Required | Max | Purpose |
| --- | --- | --- | --- | --- |
| `objective` | `string` | yes | — | The immutable run objective. Stamped by `stampObjective()`; never accepted from the LLM. |
| `currentState` | `string` | yes | 4000 chars | A prose snapshot of what is true **right now** about the work. Not a status ("done") — a description of reality ("the auth module compiles, the new session API is wired in for the OAuth flow, but the legacy `legacyLogin` path still calls the old API"). |
| `completedWork` | `string[]` | yes | 128 items × 1000 chars | Specific completed implementation items. Each entry should be independently verifiable ("`src/auth/session.ts` exports `createSession()`", "OAuth flow passes `bun test auth/oauth.test.ts`"). |
| `remainingWork` | `string[]` | yes | 128 items × 1000 chars | Concrete outstanding items. Each item should be small enough that the next session can pick it up without re-planning. |
| `filesChanged` | `string[]` | yes | 128 items × 1000 chars | File paths (relative to repo root) created, modified, or deleted by the worker. |
| `tests` | `HandoffTest[]` | yes | 64 items | Tests the worker actually ran and their results. Each entry has a `command` (e.g. `bun test`), a `result` (`PASS`/`FAIL`/`UNKNOWN`), and optional `details`. |
| `failures` | `string[]` | yes | 128 items × 1000 chars | Known failures, errors, regressions, or blockers. Be honest — the next session needs to know what is broken. |
| `decisions` | `string[]` | yes | 128 items × 1000 chars | Important architectural or implementation decisions made. Helps the next session not re-litigate settled questions. |
| `constraints` | `string[]` | yes | 128 items × 1000 chars | Requirements that must not be changed — non-negotiables from the objective or from prior decisions. |
| `nextAction` | `string` | yes | 2000 chars | The **single** most important next action. The next session is told to start here. |
| `generatedAt` | `string` | yes (auto) | — | ISO timestamp. Set by `coerceToHandoff()` or `normalizeHandoff()` when the controller accepts the handoff. |

**Validation.** Every handoff produced by the LLM is validated before
acceptance:

- All required fields present and non-empty (for strings) or arrays (for
  lists).
- No string exceeds its `maxLen`.
- No array exceeds its `maxItems`.
- No array item exceeds its `itemMax`.
- Every `tests[i].result` is one of `PASS`, `FAIL`, `UNKNOWN`.
- `tests[i].command` and `tests[i].details`, if present, are strings.

If validation fails, the controller retries handoff generation **once**. If
the retry also fails, the run enters `error` phase with `lastError =
'Handoff generation failed after retry.'`.

**Prompt generation.** The handoff-generation prompt is built by
`buildHandoffPrompt(objective)` (default schema) or
`buildHandoffPromptFromSchema(objective, schema)` (custom schema). Both
prompts:

- Forbid code changes, task continuation, or explanation.
- Demand a single JSON object with exactly the schema fields.
- Embed the original objective as grounding (with the explicit instruction
  not to change it).
- Tell the LLM to inspect the actual repository state to ground every field,
  not to trust prior conversation claims.

**Serialization.** When the handoff is sent into the next session, it is
serialized into a compact text format by `serializeHandoff(h)` (or
`serializeHandoffWithSchema(h, schema)` for custom schemas). The format is
designed to be cheap to embed in a prompt and easy for the LLM to scan:

```
AUTONOMOUS SESSION HANDOFF

ORIGINAL OBJECTIVE
<the immutable objective>

CURRENT STATE
<currentState prose>

COMPLETED WORK
- <item 1>
- <item 2>

REMAINING WORK
- <item 1>

FILES CHANGED
- <path 1>

TESTS
- bun test: PASS
- bun test auth/oauth.test.ts: FAIL — missing token refresh case

FAILURES
- (none)

DECISIONS
- <decision>

CONSTRAINTS
- <constraint>

EXACT NEXT ACTION
<nextAction>

AUTONOMOUS PHASE
WORK
```

Empty arrays render as `- (none)`. The trailing `AUTONOMOUS PHASE / WORK`
block is a structural marker consumed by some downstream tooling.

## 1.4 The state machine

The controller is a state machine. Every run is in exactly one **phase** at
a time, with an overarching **status** that classifies the run as a whole.

**Status values** (`AutonomousRunStatus`):

| Status | Meaning |
| --- | --- |
| `active` | The run is in progress. The controller is responding to events. |
| `completed` | The verifier emitted `AUTONOMOUS_VERIFICATION: PASS`. The run is finished successfully. |
| `stopped` | The user called `stopRun()`. State is preserved; the user can `resumeRun()`. |
| `error` | A hard failure occurred (handoff generation failed twice, verifier produced no marker, budget exhausted, verification budget exhausted). The run is halted; user intervention is required. |

**Phase values** (`AutonomousPhase`):

| Phase | Meaning |
| --- | --- |
| `working` | A worker session is active and doing task work. |
| `handoff` | The controller has asked the current worker to produce a structured handoff. Awaiting its response. |
| `creating-session` | The handoff has been generated and validated; the controller is creating a fresh session (worker for rollover, or verifier for completion). |
| `verifying` | A verifier session is active and independently checking the work. |
| `completed` | Terminal. Verifier passed. |
| `stopped` | Terminal (until resumed). User stopped the run. |
| `error` | Terminal. Hard failure. |

**Transitions.** Each transition is triggered by a specific event:

| From | To | Trigger |
| --- | --- | --- |
| (none) | `working` | `startRun()` called. |
| `working` | `handoff` | Rollover pending (context/turns/time/cost policy tripped) — `performRollover()` entered. |
| `working` | `verifying` | Worker emitted `AUTONOMOUS_STATUS: COMPLETE` — `handleWorkerComplete()` entered (after budget check + final handoff generation). |
| `handoff` | `creating-session` | Handoff generated and validated successfully. |
| `handoff` | `error` | Handoff generation failed twice (after one retry). |
| `creating-session` | `working` | Fresh session created, continuation prompt sent, navigation done, generation incremented. |
| `verifying` | `completed` | Verifier emitted `AUTONOMOUS_VERIFICATION: PASS`. |
| `verifying` | `working` | Verifier emitted `AUTONOMOUS_VERIFICATION: FAIL`. New worker session spun up with the verifier's findings as the next handoff. |
| `verifying` | `error` | Verifier emitted neither `PASS` nor `FAIL` (malformed marker). |
| `working`/`handoff`/`creating-session`/`verifying` | `stopped` | `stopRun()` called. |
| `stopped` | `working`/`verifying` | `resumeRun()` called. The phase is restored from `phaseBeforeStop`; if the stop happened mid-rollover, the phase is reset to `working` with `rolloverPending=true`. |
| any | `error` | Cost budget exhausted (`maxTotalCostCents`) or verification budget exhausted (`maxVerificationAttempts`). |

**Priority order at turn-finish.** When `onTurnFinished` fires for a
worker session, the controller evaluates conditions in this strict order:

1. **Verification result** — if `phase === 'verifying'`, classify the
   verifier's last message and route to pass/fail/error handlers. Return.
2. **Cost budget** — if `totalCostCents >= maxTotalCostCents`, halt with
   `error` and emit `budget.exhausted`. Return.
3. **Worker completion** — if the worker emitted
   `AUTONOMOUS_STATUS: COMPLETE`, route to `handleWorkerComplete()`.
   Completion **always** takes precedence over rollover. Return.
4. **Rollover evaluation** — if no rollover is yet pending, re-evaluate the
   policy (turns/time/cost can only trip here; context trips in
   `onContextUsage`). If a policy trips, mark `rolloverPending=true` and
   record the `rolloverReason`.
5. **Rollover execution** — if `rolloverPending`, call `performRollover()`.
   Return.
6. **Continue** — otherwise, log the turn and wait for the next event.

The serialized transition queue (see §6.6) guarantees that two turn-finish
events arriving in quick succession cannot trigger two concurrent
rollovers.

---

# Part 2 — Configuration Reference

This section documents every configurable field in the system. For each
field: name, type, default, valid range, what it does, when to change it,
when **not** to change it, and an example.

## 2.1 `AutonomousSettings`

The top-level settings object. Stored at `autonomous-settings.json` in
Goose's app-data directory. Read by the controller at every event via
`effectiveSettings()`.

```ts
interface AutonomousSettings {
  enabled: boolean;
  rolloverThreshold: number;              // 0..1, default 0.75
  maxVerificationAttempts?: number;       // v0.4
  rolloverPolicy?: RolloverPolicy;        // v0.4
  maxTotalCostCents?: number;            // v0.6
  webhooks?: string[] | WebhookConfig[]; // v0.6/v0.7
}
```

### `enabled`

| Property | Value |
| --- | --- |
| Type | `boolean` |
| Default | `false` |
| Valid range | `true` \| `false` |
| What it does | Master switch. When `false`, the controller's hooks (installed by the patches) are no-ops — Goose runs as if the autonomous module were not installed. When `true`, the controller responds to context-usage and turn-finish events. |
| When to change | Set `true` when you want to start an autonomous run. Set `false` to disable the controller entirely (e.g. for normal interactive Goose use). |
| When **not** to change | Leave `false` if you are doing normal pair-programming with Goose — the controller adds overhead and would attempt rollover on long tasks. |
| Example | `{ "enabled": true }` |

### `rolloverThreshold`

| Property | Value |
| --- | --- |
| Type | `number` |
| Default | `0.75` (from `DEFAULT_ROLLOVER_THRESHOLD`) |
| Valid range | `0`–`1` (inclusive). `0` disables context-based rollover. |
| What it does | The legacy context-ratio threshold (v0.1–v0.3). When `contextUsage / contextLimit >= rolloverThreshold`, the next worker turn triggers a rollover. Still respected in v1.0 for backward compatibility — it is the canonical source for `contextPercent` when `rolloverPolicy` is omitted or when `rolloverPolicy.contextPercent` is unset. |
| When to change | Lower it (e.g. `0.6`) if your model degrades badly near the context limit or if you see lots of "stuck" late-session turns. Raise it (e.g. `0.85`) if your model handles long context well and you want fewer rollovers (cheaper, less handoff-generation overhead). |
| When **not** to change | Leave at `0.75` if you have no specific reason — it is a reasonable default for most modern long-context models. |
| Example | `{ "rolloverThreshold": 0.65 }` |

### `maxVerificationAttempts`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `undefined` (unlimited — v0.1–v0.3 behaviour) |
| Valid range | Positive integer. `0` or `undefined` = unlimited. |
| What it does | Safety valve against infinite `verify → fail → worker → complete → verify → fail …` loops. Each time a worker emits `COMPLETE` and the controller creates a verifier, `verificationAttempt` is incremented. If the next attempt would exceed the budget, the run enters `error` phase with `lastError = 'Verification budget exhausted (N/M attempts)...'`. |
| When to change | Set to a small number (2–4) when you want bounded runs — useful for overnight tasks where an infinite loop would burn through credits. |
| When **not** to change | Leave unset if you are running interactively and want to retry verification as many times as it takes. |
| Example | `{ "maxVerificationAttempts": 3 }` |

### `maxTotalCostCents`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `undefined` (unlimited — v0.1–v0.5 behaviour) |
| Valid range | Positive number (in cents). `0` or `undefined` = unlimited. |
| What it does | Hard run-wide cost budget. The controller accumulates `totalCostCents` from `AgentTurn.costCents` (reported by the host on every turn-finish). When `totalCostCents >= maxTotalCostCents`, the run halts in `error` phase and emits a `budget.exhausted` webhook. Distinct from `rolloverPolicy.maxCostCentsPerSession` (which is per-session and triggers a rollover, not a halt). |
| When to change | Set this whenever you are running overnight / unattended and want a hard ceiling on spend. Typical values: `500` ($5), `2000` ($20), `10000` ($100) depending on task scope. |
| When **not** to change | Leave unset for interactive runs where you want to monitor cost via the dashboard and intervene manually. |
| Example | `{ "maxTotalCostCents": 2000 }` (halt at $20) |

### `webhooks`

| Property | Value |
| --- | --- |
| Type | `string[] \| WebhookConfig[] \| undefined` |
| Default | `undefined` (no webhooks) |
| Valid range | Any array of URLs (strings) or `WebhookConfig` objects, or a mix. |
| What it does | A list of webhook destinations that receive `WebhookPayload` POSTs on every run event. v0.6 accepted bare URL strings (all events, no signing, default retry). v0.7 added `WebhookConfig` for per-URL event filtering + HMAC signing. v0.8 added `WebhookRetryPolicy`. v0.9 added delivery log + replay. Bare strings are normalized to `{ url }` (all events, no secret, default retry: 1 retry, 2s fixed backoff). |
| When to change | Set this when you want external notification of run events — Slack alerts, a custom dashboard, a CI trigger, an audit log, etc. |
| When **not** to change | Leave unset if you only need the local dashboard — the dashboard reads state files directly and does not use webhooks. |
| Example | `{ "webhooks": [ { "url": "https://hooks.slack.com/...", "events": ["run.completed", "run.failed"], "secret": "shared-secret", "retry": { "maxAttempts": 3, "backoffStrategy": "exponential", "jitter": true } } ] }` |

### `rolloverPolicy`

| Property | Value |
| --- | --- |
| Type | `RolloverPolicy \| undefined` |
| Default | `undefined` — falls back to legacy `rolloverThreshold` for context-based rollover only. |
| What it does | v0.4 multi-policy rollover. When present, the controller combines all four sub-policies (`contextPercent`, `maxTurnsPerSession`, `maxMinutesPerSession`, `maxCostCentsPerSession`) with OR semantics — any one tripping marks rollover pending. If `contextPercent` is omitted, it is sourced from `rolloverThreshold`. |
| When to change | Set this when you want rollover triggered by something other than (or in addition to) context usage — e.g. turn-cap sessions for reproducibility, time-cap sessions to bound latency, or cost-cap sessions to bound spend per session. |
| When **not** to change | Leave unset if context-percentage is the only trigger you need — `rolloverThreshold` alone is simpler and equivalent. |
| Example | `{ "rolloverPolicy": { "contextPercent": 0.7, "maxTurnsPerSession": 25, "maxMinutesPerSession": 30, "maxCostCentsPerSession": 100 } }` |

## 2.2 `RolloverPolicy`

```ts
interface RolloverPolicy {
  contextPercent?: number;          // 0..1, default 0.75
  maxTurnsPerSession?: number;     // 0/undefined = disabled
  maxMinutesPerSession?: number;   // 0/undefined = disabled
  maxCostCentsPerSession?: number; // 0/undefined = disabled
}
```

### `contextPercent`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `0.75` (sourced from `rolloverThreshold` when omitted) |
| Valid range | `0`–`1`. `0` disables context-based rollover. |
| What it does | When `contextUsage / contextLimit >= contextPercent`, rollover is marked pending with `rolloverReason='context'`. |
| When to change | Lower if your model degrades near the limit. Raise if your model handles long context well. Set to `0` to disable context-based rollover entirely (use only turns/time/cost). |
| When **not** to change | If you already set `rolloverThreshold`, leave this unset — they would duplicate each other and `contextPercent` (when present) takes precedence. |
| Example | `{ "contextPercent": 0.65 }` |

### `maxTurnsPerSession`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `undefined` (disabled) |
| Valid range | Positive integer. `0`/`undefined` = disabled. |
| What it does | Caps the number of completed worker turns in a session. After the Nth turn, `evaluateRollover()` returns `shouldRollOver=true` with `reason='turns'`. Useful for reproducibility (every session is exactly N turns) and for bounding context size when you can't measure it directly. |
| When to change | Use when your model's context measurement is unreliable (some providers report `accumulatedTotalTokens` inaccurately), or when you want sessions of predictable size. |
| When **not** to change | Don't set if you have reliable context measurement and want sessions to use as much context as possible — turn-based rollover tends to under-use context. |
| Example | `{ "maxTurnsPerSession": 20 }` |

### `maxMinutesPerSession`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `undefined` (disabled) |
| Valid range | Positive number (minutes). `0`/`undefined` = disabled. |
| What it does | Caps the wall-clock duration of a session. The elapsed time since `currentSessionStartedAt` is computed at every turn boundary; when it exceeds this value, rollover is marked pending with `reason='time'`. |
| When to change | Use when you want bounded session latency (e.g. for predictable monitoring), or when a session may stall (the model enters a slow loop but never trips context). |
| When **not** to change | Don't set if your tasks have legitimate long-running phases (e.g. waiting on a build) — the timer doesn't distinguish active work from idle wait. |
| Example | `{ "maxMinutesPerSession": 30 }` |

### `maxCostCentsPerSession`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `undefined` (disabled) |
| Valid range | Positive number (cents). `0`/`undefined` = disabled. |
| What it does | Caps the per-session token cost. The controller accumulates `sessionCostCents` from `AgentTurn.costCents`. When `sessionCostCents >= maxCostCentsPerSession`, rollover is marked pending with `reason='cost'`. Per-session — does **not** halt the run. To halt the entire run, use `maxTotalCostCents`. |
| When to change | Use to bound per-session spend (e.g. "no single session should cost more than $1"). Useful when individual sessions sometimes spiral on a hard sub-problem. |
| When **not** to change | Don't set if you only care about total run spend — `maxTotalCostCents` is the right tool for that. |
| Example | `{ "maxCostCentsPerSession": 100 }` (force rollover at $1 per session) |

## 2.3 `WebhookConfig`

```ts
interface WebhookConfig {
  url: string;
  events?: WebhookEvent[];
  secret?: string;
  retry?: WebhookRetryPolicy;
}
```

### `url`

| Property | Value |
| --- | --- |
| Type | `string` |
| Default | (required) |
| Valid range | Any valid `http://` or `https://` URL reachable from the controller process. |
| What it does | The endpoint to POST `WebhookPayload` JSON to. The controller uses `fetch()` with a 5-second timeout. Any non-2xx response (status ≥ 400) is treated as failure and retried per the retry policy. |
| When to change | Set to your receiver's URL. |
| When **not** to change | — |
| Example | `{ "url": "https://my-app.example.com/api/goose-webhook" }` |

### `events`

| Property | Value |
| --- | --- |
| Type | `WebhookEvent[] \| undefined` |
| Default | `undefined` (all events) |
| Valid range | Any subset of the 10 event types listed in Part 4. |
| What it does | Allowlist. If set, only events of the listed types are delivered to this URL. Filtered events are recorded in the delivery log with `result='skipped'` — they are not retried. |
| When to change | Set this when the receiver only cares about specific events (e.g. only `run.completed` and `run.failed` for a Slack alert integration). Reduces receiver noise and bandwidth. |
| When **not** to change | Leave unset if you want all events (e.g. for an audit log). |
| Example | `{ "events": ["run.completed", "run.failed", "budget.exhausted"] }` |

### `secret`

| Property | Value |
| --- | --- |
| Type | `string \| undefined` |
| Default | `undefined` (no signing) |
| Valid range | Any non-empty string. Should be unguessable — use a 32+ character random value. |
| What it does | When set, every delivery includes an `X-Goose-Autonomous-Signature: sha256=<hex>` header containing the HMAC-SHA256 of the raw request body. Receivers verify with `verifySignature(secret, body, header)` (exported from the package). Prevents forgery if the URL is public. |
| When to change | Always set this when delivering to a public URL or any URL not behind your own auth. |
| When **not** to change | Can be omitted for local-network delivery where transport security is sufficient. |
| Example | `{ "secret": process.env.GOOSE_WEBHOOK_SECRET }` |

### `retry`

| Property | Value |
| --- | --- |
| Type | `WebhookRetryPolicy \| undefined` |
| Default | `undefined` — uses `{ maxAttempts: 2, backoffMs: 2000, backoffStrategy: 'fixed', jitter: false }` |
| Valid range | See `WebhookRetryPolicy` below. |
| What it does | Overrides the default retry behaviour for failed deliveries. |
| When to change | Set when the default (one retry, 2s delay) is too aggressive (receiver rate-limits you) or too lenient (transient outages need more retries). |
| When **not** to change | Leave unset for typical use — the default is reasonable for most receivers. |
| Example | `{ "retry": { "maxAttempts": 5, "backoffMs": 1000, "backoffStrategy": "exponential", "jitter": true } }` |

## 2.4 `WebhookRetryPolicy`

```ts
interface WebhookRetryPolicy {
  maxAttempts?: number;
  backoffMs?: number;
  backoffStrategy?: 'fixed' | 'exponential';
  jitter?: boolean;
}
```

### `maxAttempts`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `2` |
| Valid range | Positive integer. `1` = no retry (single attempt). |
| What it does | Total delivery attempts (including the first). `2` means try once, then retry once. `5` means up to five total attempts. |
| When to change | Raise for flaky receivers. Lower to `1` for at-most-once semantics. |
| When **not** to change | Leave at `2` for typical use. |
| Example | `{ "maxAttempts": 5 }` |

### `backoffMs`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `2000` (ms) |
| Valid range | Non-negative integer. |
| What it does | Delay between retries. With `backoffStrategy: 'fixed'`, every retry waits exactly `backoffMs`. With `'exponential'`, retry N waits `backoffMs * 2^(N-1)` (so `2000`, `4000`, `8000`, …). |
| When to change | Raise for receivers that need cool-down time (e.g. rate-limited APIs). Lower for low-latency alerting. |
| When **not** to change | Leave at `2000` for typical use. |
| Example | `{ "backoffMs": 5000 }` |

### `backoffStrategy`

| Property | Value |
| --- | --- |
| Type | `'fixed' \| 'exponential' \| undefined` |
| Default | `'fixed'` |
| Valid range | `'fixed'` or `'exponential'` |
| What it does | `'fixed'` waits `backoffMs` between every retry. `'exponential'` doubles the delay each retry (`backoffMs`, `2×backoffMs`, `4×backoffMs`, …) — better for receivers recovering from an outage. |
| When to change | Use `'exponential'` for receivers that may be down for an extended period (gives them time to recover). Use `'fixed'` for transient errors (network blips). |
| When **not** to change | Leave at `'fixed'` for typical use. |
| Example | `{ "backoffStrategy": "exponential" }` |

### `jitter`

| Property | Value |
| --- | --- |
| Type | `boolean \| undefined` |
| Default | `false` |
| Valid range | `true` \| `false` |
| What it does | v0.9. When `true`, adds a random `0`–`50%` of the computed delay as jitter. Prevents the **thundering-herd problem**: if you have many webhooks all failing simultaneously (e.g. network outage), without jitter they all retry at the same instant and may overwhelm the receiver when it recovers. With jitter, retries spread out. |
| When to change | Enable when you have many webhooks, or when delivering to a shared/scalable receiver (e.g. a serverless function that scales on request count). |
| When **not** to change | Leave `false` for a single webhook with a single retry — jitter adds variance without much benefit. |
| Example | `{ "jitter": true }` |

## 2.5 `HandoffSchema` / `HandoffField`

The default handoff has 9 LLM-produced fields (the 10th, `objective`, is
stamped by the controller). A custom `HandoffSchema` lets you extend,
replace, or tighten these fields without forking the controller.

```ts
type HandoffFieldType = 'string' | 'string[]' | 'test[]';

interface HandoffField {
  name: string;
  type: HandoffFieldType;
  required: boolean;
  description: string;
  maxLen?: number;       // for 'string'
  maxItems?: number;     // for 'string[]' and 'test[]'
  itemMax?: number;      // for 'string[]' items and 'test[]'.details
  label?: string;        // serialization label; defaults to uppercased name
}

type HandoffSchema = HandoffField[];
```

### `name`

| Property | Value |
| --- | --- |
| Type | `string` |
| Default | (per field) |
| Valid range | Any valid JSON object key. Must be unique within the schema. |
| What it does | The JSON key for this field in the handoff object and the prompt. If a custom field has the same `name` as a built-in, the custom field **replaces** the built-in (useful for tightening constraints, e.g. raising `maxLen`). |
| When to change | Always set. |
| When **not** to change | — |
| Example | `name: 'securityReview'` |

### `type`

| Property | Value |
| --- | --- |
| Type | `'string' \| 'string[]' | 'test[]'` |
| Default | (per field) |
| Valid range | One of the three literal values. |
| What it does | Validation + serialization discriminator. `'string'` expects a single string. `'string[]'` expects an array of strings. `'test[]'` expects an array of `HandoffTest` objects (`{ command?, result: 'PASS'|'FAIL'|'UNKNOWN', details? }`). |
| When to change | Pick based on the shape of the data the LLM should produce. |
| When **not** to change | — |
| Example | `type: 'string[]'` |

### `required`

| Property | Value |
| --- | --- |
| Type | `boolean` |
| Default | (per field) |
| Valid range | `true` \| `false` |
| What it does | If `true`, the field must be present and (for strings) non-empty. If `false`, the field may be absent, `null`, or `undefined`. |
| When to change | Set `true` for fields the next session can't function without. Set `false` for nice-to-have fields (e.g. `securityReview` only when there's something security-relevant). |
| When **not** to change | Don't set `false` on `currentState`/`nextAction` — the next session needs them. |
| Example | `required: false` |

### `description`

| Property | Value |
| --- | --- |
| Type | `string` |
| Default | (per field) |
| Valid range | Any string. Should be one short sentence. |
| What it does | Embedded verbatim in the handoff-generation prompt as a `// comment` after the field's type. Tells the LLM exactly what to put here. The single most important prompt-engineering lever for handoff quality. |
| When to change | Always set. Be specific — "what is true right now" beats "current status". |
| When **not** to change | — |
| Example | `description: 'brief security review note (threats, mitigations)'` |

### `maxLen`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | (per field; built-ins use `HANDOFF_FIELD_MAX.currentState=4000` and `HANDOFF_FIELD_MAX.nextAction=2000`) |
| Valid range | Positive integer. |
| What it does | For `'string'` fields only. Maximum character length. Validation rejects longer values. |
| When to change | Lower for short fields (e.g. a 1-sentence summary) to prevent prompt bloat. Raise for fields that need detail (e.g. an extensive security review). |
| When **not** to change | Leave unset if you don't care — built-in defaults are reasonable. |
| Example | `maxLen: 1000` |

### `maxItems`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `HANDOFF_FIELD_MAX.listItems=128` for `string[]`; `HANDOFF_FIELD_MAX.tests=64` for `test[]` |
| Valid range | Positive integer. |
| What it does | For array fields. Maximum number of items. Validation rejects larger arrays. |
| When to change | Lower for fields where 128 items would bloat the prompt (e.g. a "breakingChanges" list rarely needs more than 10). Raise only if you genuinely need more. |
| When **not** to change | Leave at the default for typical use. |
| Example | `maxItems: 32` |

### `itemMax`

| Property | Value |
| --- | --- |
| Type | `number \| undefined` |
| Default | `HANDOFF_FIELD_MAX.item=1000` for `string[]` items |
| Valid range | Positive integer. |
| What it does | For `'string[]'` fields: max character length of each array item. (For `'test[]'`, the `details` sub-field has no enforced max — only `command` and `details` type checks are done.) |
| When to change | Lower for fields where each item should be a short label (e.g. file paths are typically < 200 chars). Raise for fields where items may be longer prose. |
| When **not** to change | Leave at default for typical use. |
| Example | `itemMax: 500` |

### `label`

| Property | Value |
| --- | --- |
| Type | `string \| undefined` |
| Default | Upper-cased `name` (e.g. `name: 'securityReview'` → `label: 'SECURITY REVIEW'`) |
| Valid range | Any string. |
| What it does | The heading used when serializing the handoff into the compact text format for the next session's prompt. Override only if the upper-cased name is unclear. |
| When to change | Set when the field name is an abbreviation or non-English word whose upper-cased form would be confusing. |
| When **not** to change | Leave unset for typical use. |
| Example | `label: 'SECURITY REVIEW'` |

**Schema composition.** Use `createHandoffSchema(base, extensions)` to
extend the default schema. Extensions override base fields with the same
name:

```ts
import { createHandoffSchema, defaultHandoffSchema } from 'goose-autonomous-sessions';

const schema = createHandoffSchema(defaultHandoffSchema(), [
  { name: 'securityReview', type: 'string', required: false,
    description: 'brief security review note (threats, mitigations)',
    maxLen: 1000, label: 'SECURITY REVIEW' },
  { name: 'breakingChanges', type: 'string[]', required: true,
    description: 'list of breaking API/behavior changes',
    maxItems: 32, itemMax: 500, label: 'BREAKING CHANGES' },
]);
```

Pass the schema via `ControllerDeps.handoffSchema`. When set, the controller
uses `buildHandoffPromptFromSchema`, `parseHandoffResponseWithSchema`,
`isValidHandoffAgainstSchema`, `serializeHandoffWithSchema`, and
`coerceToHandoff` instead of the default-schema equivalents. Custom fields
beyond the built-in 9 are preserved through `coerceToHandoff` as the
underlying JSON object — they are accessible via `run.handoff` after
generation, but the `Handoff` TypeScript interface only types the 9
built-ins.

## 2.6 `ControllerDeps`

The controller's constructor takes a single `ControllerDeps` object. Every
field is a seam — the controller has zero hard dependencies on the host
runtime.

```ts
interface ControllerDeps {
  store: StateStoreAdapter;
  logger: LoggerAdapter;
  generateHandoffResponse: HandoffGenerator;
  sendPrompt: ContinuationPromptSender;
  handoffSchema?: HandoffSchema;
  settings?: AutonomousSettings;
  webhookNotifier?: WebhookNotifier;
}
```

### `store`

| Property | Value |
| --- | --- |
| Type | `StateStoreAdapter` |
| Default | (required — no default) |
| What it does | Persistence seam. The controller calls `getRun`, `saveRun`, `clearRun`, `getSettings`, `saveSettings`, `recordSession`, `updateSessionStatus`, `getSessions`, `clearSessions` on it. Concrete implementations: `electronStateStore` (Goose Desktop, JSON file in app-data), Prisma/SQLite adapter (Next.js demo), in-memory adapter (standalone scripts). |
| When to change | Pick the implementation that matches your host. Goose Desktop: use `electronStateStore` (auto-wired by `install.sh`). |
| When **not** to change | Never swap mid-run — the controller caches nothing; every call hits the store, so a swap mid-run would be visible immediately but the swap itself is not atomic. |
| Example | (see `adapters/electron-state-store.ts`) |

The full `StateStoreAdapter` interface:

```ts
interface StateStoreAdapter {
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
  updateSessionStatus(sessionId: string, status: 'active' | 'completed' | 'failed' | 'abandoned'): Promise<void>;
  getSessions(runId?: string): Promise<SessionRecord[]>;
  clearSessions(runId?: string): Promise<void>;
}
```

### `logger`

| Property | Value |
| --- | --- |
| Type | `LoggerAdapter` |
| Default | (required — no default) |
| What it does | Logging seam. Three methods: `info`, `warn`, `error`, each taking `(message, runId?)`. Concrete implementations: `electronLogger` (writes to `autonomous.log.jsonl` in app-data, capped at `MAX_LOG_ROWS=500` rows), Prisma-backed logger (Next.js demo), console logger (standalone). |
| When to change | Pick the implementation that matches your host. |
| When **not** to change | — |
| Example | (see `adapters/electron-logger.ts`) |

```ts
interface LoggerAdapter {
  info(message: string, runId?: string): Promise<void>;
  warn(message: string, runId?: string): Promise<void>;
  error(message: string, runId?: string): Promise<void>;
}
```

### `generateHandoffResponse`

| Property | Value |
| --- | --- |
| Type | `HandoffGenerator = (input: { sessionId, objective, prompt }) => Promise<string \| null>` |
| Default | (required — no default) |
| What it does | Strategy for asking the current worker session to produce a structured handoff. The controller builds the prompt (via `buildHandoffPrompt` or `buildHandoffPromptFromSchema`), passes it along with the `sessionId` and `objective`, and expects the raw LLM response string back. Returns `null` if the host could not elicit a response (session gone, network error, etc.). The controller retries once on `null` or parse/validation failure. |
| When to change | Provide a custom implementation when your host uses a non-standard way to send prompts (e.g. a custom LLM gateway, a different ACP version). |
| When **not** to change | Use `acpHandoffGenerator` (auto-wired by `install.sh`) for Goose Desktop. |
| Example | (see `adapters/acp-integration.ts`) |

### `sendPrompt`

| Property | Value |
| --- | --- |
| Type | `ContinuationPromptSender = (input: { sessionId, prompt, origin }) => Promise<void>` |
| Default | (required — no default) |
| What it does | Strategy for sending a continuation or verification prompt into a freshly created session. `origin` is `'continuation'` (rollover or post-fail worker) or `'verification'` (new verifier). The host implementation typically calls ACP's `session/prompt` with the new session id. |
| When to change | Provide a custom implementation when your host uses a non-standard way to send prompts. |
| When **not** to change | Use `acpSendPrompt` (auto-wired by `install.sh`) for Goose Desktop. |
| Example | (see `adapters/acp-integration.ts`) |

### `handoffSchema`

| Property | Value |
| --- | --- |
| Type | `HandoffSchema \| undefined` |
| Default | `undefined` — uses `defaultHandoffSchema()` |
| What it does | Custom handoff schema. When set, the controller uses schema-aware prompt building, parsing, validation, serialization, and coercion. See §2.5. |
| When to change | Set when you need custom handoff fields (security reviews, breaking-changes lists, performance benchmarks, etc.). |
| When **not** to change | Leave unset if the default 9 fields are sufficient — schema-aware code paths add a small amount of overhead and complexity. |
| Example | (see §2.5 schema composition) |

### `settings`

| Property | Value |
| --- | --- |
| Type | `AutonomousSettings \| undefined` |
| Default | `undefined` — uses run-time settings from `store.getSettings()` |
| What it does | v0.4 settings override. When set, the controller uses these settings for **every** event (verification budget, rollover policy, max total cost, webhooks) instead of the settings supplied at `startRun` time. Useful for hosts that want to change settings mid-run without restarting. |
| When to change | Set when you want to override the persisted settings for the lifetime of this controller instance — e.g. for testing, or for a host that manages settings in-memory. |
| When **not** to change | Leave unset in Goose Desktop — the user's settings (managed via the Settings UI) should be authoritative. |
| Example | `settings: { enabled: true, rolloverThreshold: 0.65, maxVerificationAttempts: 3 }` |

### `webhookNotifier`

| Property | Value |
| --- |--- |
| Type | `WebhookNotifier \| undefined` |
| Default | `undefined` — built from `settings.webhooks` via `createWebhookNotifier()` |
| What it does | v0.6 webhook notifier override. When set, the controller uses this notifier for all events instead of building one from settings. Useful for testing (inject a mock) or for hosts that want full control over delivery (e.g. a queue-based async notifier). |
| When to change | Set when you want to bypass the built-in notifier — typically for tests or for advanced delivery semantics. |
| When **not** to change | Leave unset in Goose Desktop — let the controller build one from `settings.webhooks`. |
| Example | `webhookNotifier: async (payload) => { myQueue.push(payload); }` |

---

# Part 3 — Markers Reference

Markers are exact-line strings the controller scans for in the worker's and
verifier's last assistant message. They are the model's only way to signal
phase transitions.

**Matching rule.** Markers are matched as **exact lines** using these
regexes (defined in `constants.ts`):

```ts
REGEX_WORKER_COMPLETE = /^AUTONOMOUS_STATUS:\s*COMPLETE\s*$/m
REGEX_WORKER_CONTINUE = /^AUTONOMOUS_STATUS:\s*CONTINUE\s*$/m
REGEX_VERIFY_PASS     = /^AUTONOMOUS_VERIFICATION:\s*PASS\s*$/m
REGEX_VERIFY_FAIL     = /^AUTONOMOUS_VERIFICATION:\s*FAIL\s*$/m
```

Notes on the matching:

- `^` and `$` anchor to line start/end (the `m` flag enables multiline
  mode).
- `\s*` permits any amount of leading/trailing whitespace **after** the
  colon and **at** end-of-line (but no other characters).
- The marker must be on its own line. Embedding it in a sentence
  ("`AUTONOMOUS_STATUS: COMPLETE` was the marker") will **not** match — the
  line must be exactly the marker (plus optional surrounding whitespace).
- Markdown fences, code blocks, and inline backticks around the marker
  **do** defeat the regex — the `^…$` anchors require the line to be the
  marker alone. In practice the LLM rarely wraps the marker; if it does,
  the controller falls through to `unknown`.

**The four markers.**

### `AUTONOMOUS_STATUS: COMPLETE`

| Property | Value |
| --- | --- |
| Constant | `MARKER_WORKER_COMPLETE` |
| Regex | `REGEX_WORKER_COMPLETE` |
| Emitted by | Worker session, at end of its turn. |
| What it means | "I believe the entire original objective is genuinely complete." |
| What happens when emitted | The controller routes to `handleWorkerComplete()`. It first checks the verification budget; if exhausted, halts with `error`. Otherwise it generates a final handoff, creates a verifier session, and transitions to `verifying` phase. |
| What happens when **not** emitted | The worker is presumed still working. The controller evaluates rollover policy and either performs rollover (if pending) or continues in `working` phase. |
| Precedence | Highest at turn-finish. If `COMPLETE` is present, the controller ignores any pending rollover (the work is done — no point rolling over to continue). |

### `AUTONOMOUS_STATUS: CONTINUE`

| Property | Value |
| --- | --- |
| Constant | `MARKER_WORKER_CONTINUE` |
| Regex | `REGEX_WORKER_CONTINUE` |
| Emitted by | Worker session, at end of its turn. |
| What it means | "The objective is not yet complete; I have more work to do." |
| What happens when emitted | Explicit confirmation that the worker is not done. The controller proceeds to evaluate rollover policy normally — `CONTINUE` does **not** suppress rollover. |
| What happens when **not** emitted | Same as emitting `CONTINUE` — the absence of `COMPLETE` is treated as "not done". The `CONTINUE` marker is essentially a positive acknowledgement; the controller behaves the same whether the model emits it or omits any marker. |
| Precedence | Below `COMPLETE`. If both appear in the same message (unusual), `COMPLETE` wins. |

### `AUTONOMOUS_VERIFICATION: PASS`

| Property | Value |
| --- | --- |
| Constant | `MARKER_VERIFY_PASS` |
| Regex | `REGEX_VERIFY_PASS` |
| Emitted by | Verifier session, at end of its turn. |
| What it means | "I independently inspected the repository and ran tests. The original objective is genuinely complete." |
| What happens when emitted | The controller routes to `handleVerificationPass()`. It marks the verifier session `completed`, sets `run.status='completed'` and `run.phase='completed'`, and emits `verification.passed` + `run.completed` webhooks. |
| What happens when **not** emitted | The verifier produced neither `PASS` nor `FAIL` — the controller sets `phase='error'` and `status='error'` with `lastError='Verifier produced no recognizable PASS/FAIL marker.'` |

### `AUTONOMOUS_VERIFICATION: FAIL`

| Property | Value |
| --- | --- |
| Constant | `MARKER_VERIFY_FAIL` |
| Regex | `REGEX_VERIFY_FAIL` |
| Emitted by | Verifier session, at end of its turn. |
| What it means | "I independently inspected the repository and found remaining problems." |
| What happens when emitted | The controller routes to `handleVerificationFail()`. It marks the verifier session `failed`, extracts findings (lines after the marker), constructs a new handoff whose `remainingWork` and `failures` are the findings, spins up a new worker session, sends it the continuation prompt, and transitions to `working` phase. `workerGeneration` is incremented; `verificationAttempt` is **not** incremented (it only increments on `handleWorkerComplete`). Emits `verification.failed` webhook. |
| What happens when **not** emitted | Same as for `PASS` — if neither verifier marker is present, the run errors. |

**Marker anti-patterns.** Things the model might do that **do not** trigger
the corresponding transition:

| Anti-pattern | Why it fails |
| --- | --- |
| `The status is: AUTONOMOUS_STATUS: COMPLETE.` | The `.` after `COMPLETE` means the line is not exactly `COMPLETE` — `$` fails to match. |
| `` `AUTONOMOUS_STATUS: COMPLETE` `` (in backticks) | The backticks are part of the line — `^AUTONOMOUS_STATUS:` fails to match. |
| `AUTONOMOUS_STATUS:COMPLETE` (no space) | `\s*` matches zero whitespace, so this **does** match. (Counter-example: this works.) |
| `AUTONOMOUS_STATUS : COMPLETE` (space before colon) | `^AUTONOMOUS_STATUS:` requires the colon immediately after — fails. |
| `AUTONOMOUS_STATUS: complete` (lowercase) | Case-sensitive — fails. |
| `AUTONOMOUS_STATUS: COMPLETE\n(reasons...)` | Matches — the marker is on its own line. The trailing reasons are ignored by the regex. |
| Marker inside a code block ``` ``` ``` | Depends on whether the marker line itself has backticks. If the marker is on a clean line within the block, it matches. |

**Prompt instructions.** Both `buildContinuationPrompt` and
`buildVerificationPrompt` tell the LLM the exact marker text and that it
must appear at the **end** of the response. The controller does not
enforce "at end" — it scans the entire message — but the prompt wording
encourages it.

---

# Part 4 — Webhook Events Reference

Webhooks fire on every significant run event. This section documents all
10 event types, their payloads, signing, filtering, retry, replay, and the
delivery log.

## 4.1 Event types

All 10 events (the `WebhookEvent` union):

| Event | Fires when | `details` field |
| --- | --- | --- |
| `run.started` | `startRun()` completes. The run is now `active` in `working` phase. | `{ objective: string }` |
| `run.completed` | `handleVerificationPass()` — verifier emitted `PASS`. Run is `completed`. | (none) |
| `run.failed` | Hard failure: handoff generation failed twice, final handoff failed, or verification budget exhausted. Run is `error`. | `{ reason: string, verificationAttempt?: number, maxVerificationAttempts?: number }` |
| `run.stopped` | `stopRun()` called by user. Run is `stopped`. | (none) |
| `run.resumed` | `resumeRun()` called by user. Run is back to `active`. | (none) |
| `rollover.completed` | `performRollover()` finishes — fresh worker session is active. | `{ workerGeneration: number, rolloverReason?: RolloverReason }` |
| `verification.started` | `handleWorkerComplete()` creates a verifier. | `{ attempt: number }` |
| `verification.passed` | Verifier emitted `PASS`. (Fires **before** `run.completed`.) | (none) |
| `verification.failed` | Verifier emitted `FAIL`. A new worker is being spun up. | `{ findings: string[] }` (extracted from verifier text after the FAIL marker, max 16 items, each 3–500 chars) |
| `budget.exhausted` | `checkCostBudget()` detected `totalCostCents >= maxTotalCostCents`. Run is `error`. | `{ totalCostCents: number, maxTotalCostCents: number }` |

## 4.2 Payload shape

Every event uses the same `WebhookPayload` shape:

```ts
interface WebhookPayload {
  event: WebhookEvent;
  runId: string;
  emittedAt: string;            // ISO timestamp
  run: {
    status: AutonomousRunStatus;
    phase: AutonomousPhase;
    workerGeneration: number;
    verificationAttempt: number;
    totalCostCents?: number;
    sessionCostCents?: number;
    lastError?: string;
  };
  details?: Record<string, unknown>;
}
```

The `run` snapshot is built by `buildRunSnapshot(run)` at emit time — it is
a compact subset of the full `AutonomousRun`, suitable for receivers that
need to know the run's current state without fetching the full record.

Example payload (`run.completed`):

```json
{
  "event": "run.completed",
  "runId": "a1b2c3d4-...",
  "emittedAt": "2025-01-15T12:34:56.789Z",
  "run": {
    "status": "completed",
    "phase": "completed",
    "workerGeneration": 4,
    "verificationAttempt": 1,
    "totalCostCents": 287,
    "sessionCostCents": 12,
    "lastError": null
  },
  "details": null
}
```

## 4.3 HMAC signing

When a `WebhookConfig` includes a `secret`, every delivery to that URL
includes an HTTP header:

```
X-Goose-Autonomous-Signature: sha256=<hex-hmac-of-body>
```

The signature is computed by `signPayload(secret, body)`:

```ts
import { createHmac } from 'crypto';

export function signPayload(secret: string, body: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}
```

**Receiver-side verification.** Use the exported `verifySignature` helper:

```ts
import { verifySignature } from 'goose-autonomous-sessions';

// in your webhook handler:
const body = await req.text(); // raw body, before any JSON parsing
const sig = req.headers.get('X-Goose-Autonomous-Signature');
if (!verifySignature(SECRET, body, sig)) {
  return res.status(401).json({ error: 'Invalid signature' });
}
const payload = JSON.parse(body);
// ... handle payload.event
```

`verifySignature` uses a constant-time byte comparison to prevent timing
attacks. It returns `false` if the signature header is missing, doesn't
start with `sha256=`, or doesn't match the computed HMAC.

**Critical:** verify against the **raw body string**, not a re-serialized
JSON object. `JSON.parse(...)` then `JSON.stringify(...)` may produce
different whitespace/key-ordering than the original body, and the HMAC
would not match.

## 4.4 Event filtering

If `WebhookConfig.events` is set, only events in the allowlist are
delivered. Filtered events are **not** retried — they are recorded in the
delivery log with `result='skipped'` for visibility.

Example: a Slack alert receiver that only cares about terminal events:

```ts
{
  url: 'https://hooks.slack.com/services/...',
  events: ['run.completed', 'run.failed', 'budget.exhausted'],
  secret: process.env.SLACK_WEBHOOK_SECRET,
}
```

A run that completes successfully would deliver only `run.completed` to
this URL; the intermediate `run.started`, `rollover.completed`,
`verification.started`, and `verification.passed` events would all be
skipped.

## 4.5 Retry policy

Each delivery goes through `deliverWithRetry()`. The flow:

1. Build the JSON body and headers (including the HMAC signature if
   `secret` is set).
2. `fetch()` POST with a 5-second timeout (via `AbortController`).
3. If the response status is `< 400`, record `result='delivered'` and
   stop.
4. If the response status is `>= 400` or `fetch()` throws, the delivery
   failed. Compute the backoff delay:
   - `backoffStrategy: 'fixed'` → `delay = backoffMs`
   - `backoffStrategy: 'exponential'` → `delay = backoffMs * 2^(attempt-1)`
   - If `jitter: true`, add `Math.random() * (delay * 0.5)` (0–50% of
     the delay).
5. Wait `delay` ms, then retry (increment `attempt`).
6. Stop after `maxAttempts` total attempts. Record `result='failed'` with
   the error message.

The default policy (when `WebhookConfig.retry` is unset) is
`{ maxAttempts: 2, backoffMs: 2000, backoffStrategy: 'fixed', jitter: false }`
— one initial attempt plus one retry, 2s apart.

**Important.** Deliveries are **fire-and-forget** from the controller's
perspective. The controller calls `notifier(payload).catch(() => {})` and
continues immediately. The notifier schedules each delivery on the event
loop; retries happen asynchronously and do not block the state machine.

## 4.6 Replay

Failed deliveries with a stored payload + config can be re-delivered via
`replayFailedDeliveries(logger, runId?)`.

- Returns the count of deliveries re-attempted.
- Uses `maxAttempts: 1, backoffMs: 0` for the replay (so replay itself
  does not trigger another retry cycle).
- The original failed records are **not** removed; new records are
  appended for the replay attempts, preserving the full delivery history.
- Only records with `result='failed'` AND a stored `payload` AND a stored
  `config` are replayable. (Records from before v0.9 do not have stored
  payloads and cannot be replayed.)

Invoke from the CLI:

```bash
bun cli/goose-autonomous.ts replay                    # replay all failed
bun cli/goose-autonomous.ts replay --run-id a1b2c3d4  # replay one run
```

Or via the dashboard API:

```bash
curl -X POST http://localhost:7878/api/webhooks/replay
curl -X POST 'http://localhost:7878/api/webhooks/replay?runId=a1b2c3d4'
```

## 4.7 Delivery log

Every delivery attempt is recorded in an in-memory log (capped at
`MAX_DELIVERY_RECORDS=500` most-recent records). Each record is a
`WebhookDeliveryRecord`:

```ts
interface WebhookDeliveryRecord {
  id: string;                  // UUID
  url: string;
  event: WebhookEvent;
  runId: string;
  attemptedAt: string;        // ISO timestamp
  status?: number;            // HTTP status code (undefined on network failure)
  result: 'delivered' | 'failed' | 'skipped';
  error?: string;             // error message on failure
  signed: boolean;
  attempt: number;            // 1 = first try, 2 = first retry, etc.
  payload?: WebhookPayload;  // v0.9: stored for failed deliveries (for replay)
  config?: { url: string; secret?: string; retry?: WebhookRetryPolicy };
                              // v0.9: stored for failed deliveries (for replay)
}
```

**Inspecting the log.** Three ways:

1. **CLI**: `bun cli/goose-autonomous.ts webhooks [--limit N] [--run-id ID]`
2. **Dashboard API**: `GET /api/webhooks?limit=100&runId=xxx`
3. **Dashboard HTML**: (not shown in the HTML dashboard — use the API or CLI)

**Clearing the log.** `clearDeliveryLog()` (exported) or
`DELETE /api/webhooks` (dashboard). Clears the in-memory log only — does
not affect persisted state.

**Caveat.** The log is **in-memory and per-process**. The Goose Desktop
process and the dashboard process have **separate** logs. To see live
deliveries from Goose Desktop, watch the Goose Desktop logs (or set up
webhooks to a receiver that logs them). The dashboard's log only shows
deliveries triggered by the dashboard process itself (which is rare — the
dashboard does not emit events).

---

# Part 5 — Controller API Reference

The controller class is `AutonomousSessionController`. Constructed once
with `ControllerDeps`; called repeatedly by the host's event hooks.

```ts
import { AutonomousSessionController } from 'goose-autonomous-sessions';
// or, after install.sh:
import { autonomousController } from './autonomous';
```

## 5.1 `startRun`

```ts
async startRun(input: {
  sessionId: string;
  objective: string;
  settings: AutonomousSettings;
}): Promise<AutonomousRun>
```

| Aspect | Detail |
| --- | --- |
| Purpose | Begin a new autonomous run. Creates the run record, records the initial worker session, emits `run.started`. |
| When to call | When the user starts a long-running task and Autonomous is enabled. The host (Goose Desktop's `useChatSession` patch) passes the new session's id, the user's objective text, and the persisted `AutonomousSettings`. |
| Pre-conditions | Either no existing run, or the existing run is in a terminal phase (`completed`, `stopped`, `error`, or `active` with `phase='completed'`). |
| Post-conditions | A new `AutonomousRun` is persisted with `status='active'`, `phase='working'`, `workerGeneration=1`, `verificationAttempt=0`. The initial worker session is recorded in the session lineage. |
| Throws | `Error('An autonomous run is already active.')` if a non-terminal run exists. |
| Side effects | Clears stale session lineage from any prior run. Calls `store.saveRun`, `store.recordSession`. Emits `run.started` webhook. |
| Returns | The freshly-created `AutonomousRun`. |

## 5.2 `onContextUsage`

```ts
async onContextUsage(
  sessionId: string,
  used: number,
  limit: number
): Promise<AutonomousRun | null>
```

| Aspect | Detail |
| --- | --- |
| Purpose | Report the current session's context usage. Update `run.contextUsage` and `run.contextLimit`, and evaluate the rollover policy. |
| When to call | Whenever the host has fresh context-usage data — typically inside the `useChatSession` patch's `useEffect`, which fires when the ACP `TokenState` changes. |
| Pre-conditions | A run is `active`. The `sessionId` matches `run.currentSessionId`. Otherwise the call is a no-op (returns the run unchanged). |
| Post-conditions | `run.contextUsage` and `run.contextLimit` updated. If the context policy trips (and no rollover is already pending), `rolloverPending=true` and `rolloverReason='context'`. |
| Throws | Never (errors are caught and logged). |
| Side effects | Calls `store.saveRun`. Logs `rollover pending (...)` if a policy trips. |
| Returns | The updated `AutonomousRun`, or `null` if no run exists. |
| Note | This is the **only** entry point where the context policy can trip. Turn/time/cost policies are evaluated at `onTurnFinished` because they need a turn boundary. |

## 5.3 `onTurnFinished`

```ts
async onTurnFinished(
  sessionId: string,
  lastAssistantText: string,
  turn: AgentTurn
): Promise<AutonomousRun | null>
```

| Aspect | Detail |
| --- | --- |
| Purpose | The primary state-machine driver. Called after every model turn finishes. Classifies the turn (verification result / worker completion / rollover pending / continue) and routes accordingly. |
| When to call | From the host's turn-finish hook — in Goose Desktop, the `useChatSession` patch's `onFinish` callback (the ACP `onFinish` fires when a model response completes). The host pulls `lastAssistantText` from `snapshotRef.current.messages` (the last assistant message) and constructs an `AgentTurn` with `costCents` if available. |
| Pre-conditions | A run is `active`. The `sessionId` matches `run.currentSessionId`. Otherwise the call is a no-op. |
| Post-conditions | Varies by routing — see the priority order in §1.4 and §6.5. |
| Throws | Never (errors are caught and logged; the run enters `error` phase on hard failures). |
| Side effects | May call `handleWorkerComplete`, `handleVerificationPass`, `handleVerificationFail`, `performRollover`. Each of these persists the run, records/updates sessions, sends prompts, navigates, and emits webhooks. |
| Returns | The updated `AutonomousRun`, or `null` if no run exists. |
| Serialization | All `onTurnFinished` calls (and any other transition-triggering calls) are serialized through `serialize()` — a promise chain that ensures no two transitions run concurrently. |

The `AgentTurn` argument:

```ts
interface AgentTurn {
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
  costCents?: number;  // v0.5: optional, accumulated into sessionCostCents + totalCostCents
}
```

## 5.4 `stopRun`

```ts
async stopRun(): Promise<AutonomousRun | null>
```

| Aspect | Detail |
| --- | --- |
| Purpose | User-initiated stop. Preserves state for later inspection or resumption. |
| When to call | When the user clicks "Stop" in the Goose Desktop UI (or whatever the host wires to this method). |
| Pre-conditions | A run exists. Any status is OK (stopping an already-stopped run is a no-op). |
| Post-conditions | `phaseBeforeStop` is set to the current phase. `status='stopped'`, `phase='stopped'`. Sessions, handoff, and logs are **not** deleted. |
| Throws | Never. |
| Side effects | Calls `store.saveRun`. Logs `run stopped by user`. Emits `run.stopped` webhook. |
| Returns | The updated `AutonomousRun`, or `null` if no run exists. |

## 5.5 `resumeRun`

```ts
async resumeRun(): Promise<AutonomousRun | null>
```

| Aspect | Detail |
| --- | --- |
| Purpose | Resume a stopped run. The explicit counterpart to `stopRun` (the spec says: "A stopped run should not automatically resume. The user must explicitly start/resume it." — this method is that explicit resume). |
| When to call | When the user clicks "Resume" in the Goose Desktop UI. |
| Pre-conditions | A run exists with `status='stopped'`. Otherwise throws. |
| Post-conditions | `status='active'`. The phase is restored from `phaseBeforeStop` (or `working` if `phaseBeforeStop` was `handoff` or `creating-session` — those are mid-rollover phases and we reset to `working` with `rolloverPending=true`). `currentSessionStartedAt` is reset to now (so time-based policies don't immediately re-trip). `phaseBeforeStop` is cleared. |
| Throws | `Error("Cannot resume a run in status '<status>' (only 'stopped' runs can be resumed).")` if the run is not stopped. |
| Side effects | Calls `store.saveRun`. Logs `run resumed — phase: ...`. Emits `run.resumed` webhook. |
| Returns | The updated `AutonomousRun`, or `null` if no run exists. |

## 5.6 `clearAll`

```ts
async clearAll(): Promise<void>
```

| Aspect | Detail |
| --- | --- |
| Purpose | Wipe all autonomous state — the run record and the session lineage. |
| When to call | When the user wants to start completely fresh — e.g. from the Goose Desktop Settings panel's "Clear autonomous state" button. |
| Pre-conditions | None. |
| Post-conditions | The run record is deleted. Sessions for the run (if any) are deleted. Logs are **not** deleted (they are append-only and capped at `MAX_LOG_ROWS`). Settings are **not** deleted (they persist across runs). |
| Throws | Never. |
| Side effects | Calls `store.clearRun`, `store.clearSessions`. Logs `autonomous state cleared`. |
| Returns | `void`. |

## 5.7 `getState`

```ts
async getState(): Promise<AutonomousRun | null>
```

| Aspect | Detail |
| --- | --- |
| Purpose | Read the current run. |
| When to call | Anywhere the host needs the run's current state — UI rendering, IPC handlers, recovery on startup. |
| Pre-conditions | None. |
| Post-conditions | None (read-only). |
| Throws | Never. |
| Side effects | None. |
| Returns | The current `AutonomousRun`, or `null` if no run exists. |

## 5.8 `recover` (module-level function)

```ts
// In recovery.ts — not a method on the controller:
async function recover(controller: AutonomousSessionController): Promise<AutonomousRun | null>
```

| Aspect | Detail |
| --- | --- |
| Purpose | Crash recovery. Called on Desktop startup (or any host startup) to reconcile the persisted run with the live process state. |
| When to call | Once at host startup, before the user can interact with the UI. |
| Pre-conditions | The controller must be constructed (so its `store` and `logger` are available). |
| Post-conditions | Varies by phase — see §6.7 (crash recovery decision tree). |
| Throws | Never. |
| Side effects | May call `store.saveRun`. Always logs at least one info/warn entry. |
| Returns | The reconciled `AutonomousRun`, or `null` if no run exists. |

---

# Part 6 — State Machine Reference

## 6.1 Phases

| Phase | Description | Transient or terminal? |
| --- | --- | --- |
| `working` | A worker session is active and doing task work. | Transient. |
| `handoff` | The controller has sent the handoff-generation prompt and is awaiting the LLM's response. | Transient. |
| `creating-session` | The handoff is validated; the controller is creating a fresh session (worker for rollover, or verifier for completion) and preparing to send the continuation/verification prompt. | Transient. |
| `verifying` | A verifier session is active, independently inspecting the repository. | Transient. |
| `completed` | Verifier emitted `PASS`. Run is done. | Terminal. |
| `stopped` | User called `stopRun`. Can be resumed. | Terminal (until `resumeRun`). |
| `error` | Hard failure. User intervention required. | Terminal. |

## 6.2 Statuses

| Status | Description | Can transition to? |
| --- | --- | --- |
| `active` | The run is in progress. The controller is responding to events. | `completed`, `stopped`, `error` |
| `completed` | Verifier passed. The run is finished successfully. | (terminal) |
| `stopped` | User-initiated stop. | `active` (via `resumeRun`) |
| `error` | Hard failure. | (terminal — must `clearAll` and start a new run) |

## 6.3 Transitions (full table)

| From phase | Trigger | To phase | To status | Side effects |
| --- | --- | --- | --- | --- |
| (none) | `startRun()` | `working` | `active` | Record initial worker session. Emit `run.started`. |
| `working` | `onContextUsage` reports context tripped | (still `working`, but `rolloverPending=true`) | `active` | Save run. Log rollover pending. |
| `working` | `onTurnFinished`, worker emitted `COMPLETE` | `verifying` | `active` | Generate final handoff. Increment `verificationAttempt`. Record verifier session. Mark old worker `completed`. Send verification prompt. Navigate. Emit `verification.started`. |
| `working` | `onTurnFinished`, rollover pending | `handoff` → `creating-session` → `working` | `active` | Generate handoff. Create fresh worker. Send continuation prompt. Navigate. Mark old worker `abandoned`. Increment `workerGeneration`. Reset per-session counters. Emit `rollover.completed`. |
| `working` | `onTurnFinished`, no marker, no rollover | `working` | `active` | Increment `turnsInCurrentSession`. Accumulate cost. Save run. Log turn. |
| `working` | `checkCostBudget` detects cost exhausted | `error` | `error` | Save run. Log error. Emit `budget.exhausted`. |
| `verifying` | `onTurnFinished`, verifier emitted `PASS` | `completed` | `completed` | Mark verifier `completed`. Emit `verification.passed` + `run.completed`. |
| `verifying` | `onTurnFinished`, verifier emitted `FAIL` | `working` | `active` | Extract findings. Build fail-handoff. Create fresh worker. Send continuation prompt. Navigate. Mark old verifier `failed`. Increment `workerGeneration`. Reset per-session counters. Emit `verification.failed`. |
| `verifying` | `onTurnFinished`, verifier emitted neither | `error` | `error` | Set `lastError='Verifier produced no recognizable PASS/FAIL marker.'`. Save run. Log error. |
| `handoff` | Handoff generation failed twice | `error` | `error` | Set `lastError='Handoff generation failed after retry.'`. Save run. Log error. Emit `run.failed`. |
| `working`/`handoff`/`creating-session`/`verifying` | `stopRun()` | `stopped` | `stopped` | Set `phaseBeforeStop`. Save run. Log stop. Emit `run.stopped`. |
| `stopped` | `resumeRun()` | restored from `phaseBeforeStop` (or `working` if was mid-rollover) | `active` | Reset `currentSessionStartedAt`. Clear `phaseBeforeStop`. Save run. Log resume. Emit `run.resumed`. |
| `working` | Verification budget exhausted on next `handleWorkerComplete` | `error` | `error` | Set `lastError='Verification budget exhausted (N/M attempts)...'`. Save run. Log error. Emit `run.failed`. |

## 6.4 Priority order at turn-finish (recap)

When `onTurnFinished` runs for an `active` run whose `currentSessionId`
matches:

1. **Verification routing** — if `phase === 'verifying'`, classify and
   route to `handleVerificationPass` / `handleVerificationFail` / error.
   Return.
2. **Cost budget** — `checkCostBudget(run)`. If halted, return.
3. **Turn + cost accounting** — increment `turnsInCurrentSession`, add
   `turn.costCents` to `sessionCostCents` and `totalCostCents`.
4. **Worker completion** — if `detectWorkerStatus(text) === 'complete'`,
   route to `handleWorkerComplete`. Return.
5. **Rollover re-evaluation** — if `!rolloverPending`, run
   `evaluateRollover`. If tripped, set `rolloverPending=true` and
   `rolloverReason`.
6. **Rollover execution** — if `rolloverPending`, call `performRollover`.
   Return.
7. **Continue** — log the turn, save the run, return.

The strict ordering means: completion beats rollover, and cost-budget halt
beats everything except verification routing (because a verifier turn is
the verifier's job, not the worker's, and the cost of that turn still gets
counted).

## 6.5 Serialized transition queue

The controller has a private `transitionPromise: Promise<void>`,
initialised to `Promise.resolve()`. The `serialize<T>(fn)` method chains
every transition-triggering call onto this promise:

```ts
private serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = this.transitionPromise.then(fn, fn);
  this.transitionPromise = next.then(() => undefined, () => undefined);
  return next;
}
```

Note `then(fn, fn)` — `fn` runs whether the previous transition resolved
or rejected. This ensures a failed transition doesn't permanently block
the queue.

**Why this matters.** The ACP runtime can fire `onTurnFinished` and
`onContextUsage` in rapid succession (e.g. a turn finishes, then a token
count update arrives). Without serialization, two concurrent transitions
could both see `rolloverPending=true`, both try to create fresh sessions,
and both navigate — corrupting state. The queue guarantees one transition
at a time.

## 6.6 Per-session counters (reset on every rollover / verification)

| Counter | Resets when | Purpose |
| --- | --- | --- |
| `turnsInCurrentSession` | On rollover (`performRollover`), on `handleWorkerComplete` (entering `verifying`), on `handleVerificationFail` (new worker). | Drives `maxTurnsPerSession`. |
| `currentSessionStartedAt` | Same as above. | Drives `maxMinutesPerSession`. Reset on `resumeRun` too, so time-based policies don't immediately re-trip after a stop. |
| `sessionCostCents` | Same as above. | Drives `maxCostCentsPerSession`. |
| `contextUsage` | On rollover and on `handleVerificationFail` (set to `0`). | Drives context-percent policy. (Not reset on entering `verifying` — the verifier's context is tracked separately by the host.) |
| `rolloverReason` | Cleared after each rollover / verification. | Records which policy tripped. |

`totalCostCents` is **never** reset — it accumulates across the entire
run and is checked against `maxTotalCostCents`.

`workerGeneration` only ever increments (never resets within a run).
`verificationAttempt` only increments on `handleWorkerComplete` (never
on `FAIL` — a failed verifier doesn't burn a budget slot).

## 6.7 Crash recovery decision tree

`recover(controller)` runs on host startup. Decision tree (spec §36):

```
read run from store
│
├─ run is null?
│   └─ log "no active run — nothing to do"
│      return null
│
├─ run.status === 'completed'?
│   └─ log "run already completed — clearing active record"
│      return run  (host may decide to clearAll() or leave for inspection)
│
├─ run.status === 'stopped'?
│   └─ log "run stopped by user — leaving stopped"
│      return run  (user must resumeRun())
│
├─ run.status === 'error'?
│   └─ log warn "run in error state — <lastError>"
│      return run  (user must clearAll() and start fresh)
│
└─ run.status === 'active'?
    │
    ├─ run.phase === 'handoff'?
    │   └─ Crashed during handoff generation.
    │      Reset to phase='working', rolloverPending=true.
    │      Clear transitionId, transitionStage.
    │      Save run. Log warn. Return run.
    │      → Next turn-finish will re-attempt the rollover.
    │
    ├─ run.phase === 'creating-session'?
    │   │
    │   ├─ run.pendingSessionId exists?
    │   │   └─ The new session was created but not yet activated.
    │   │      Promote: currentSessionId = pendingSessionId,
    │   │      workerGeneration += 1, phase='working', rolloverPending=false,
    │   │      contextUsage=0, transitionStage='session-active'.
    │   │      Clear transitionId. Save run. Log info. Return run.
    │   │
    │   └─ run.pendingSessionId missing?
    │       └─ The controller never created a session before crashing.
    │          Reset to phase='working', rolloverPending=true.
    │          Clear transitionId, transitionStage. Save run. Log warn.
    │          Return run. → Next turn-finish re-rolls.
    │
    ├─ run.phase === 'verifying'?
    │   └─ The verifier session is still alive (host owns it).
    │      Log info "verifier session active — reconnecting".
    │      Return run unchanged. → Host re-establishes the live session.
    │
    ├─ run.phase === 'working'?
    │   └─ Worker session is still alive.
    │      Log info "run active in working phase — reconnected".
    │      Return run unchanged.
    │
    ├─ run.phase ∈ {'completed', 'stopped', 'error'}?
    │   └─ (shouldn't happen with status='active', but defensive)
    │      Return run unchanged.
    │
    └─ default: return run unchanged.
```

The key principle is **"never guess"**: recovery never invents state. It
either reconnects to a still-live session (verifying / working), resumes a
pending transition idempotently (creating-session with pendingSessionId),
or resets to a safe re-trigger point (handoff → working with
rolloverPending; creating-session without pendingSessionId → same).

---

# Part 7 — Dashboard Reference

The dashboard is a standalone Bun script (`dashboard/server.ts`) that
reads the JSON state files written by the Electron adapter and serves a
live HTML dashboard plus a JSON API. No external dependencies — uses only
Node.js built-ins.

## 7.1 Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `AUTONOMOUS_DATA_DIR` | `~/.config/Goose` (Linux) | Directory containing `autonomous-state.json`, `autonomous-settings.json`, `autonomous-sessions.json`, `autonomous.log.jsonl`. Override if your Goose data lives elsewhere. |
| `PORT` | `7878` | HTTP port to listen on. |
| `AUTONOMOUS_DASHBOARD_TOKEN` | `''` (empty = no auth) | If set, all requests must include this token as a Bearer token **or** as a `?token=` query param. |

## 7.2 Auth

When `AUTONOMOUS_DASHBOARD_TOKEN` is set, every request (except the 401
response itself) is checked by `checkAuth()`:

- Bearer token in `Authorization` header:
  `Authorization: Bearer <token>`
- OR query param: `http://localhost:7878/?token=<token>`

Without the token, requests get `401 Unauthorized` with body:

```json
{ "error": "Unauthorized. Set AUTONOMOUS_DASHBOARD_TOKEN or pass ?token=..." }
```

When the env var is empty, auth is disabled (suitable for local dev).

## 7.3 HTTP endpoints

| Path | Method | Auth | Purpose | Response |
| --- | --- | --- | --- | --- |
| `/` | GET | yes | The HTML dashboard. | `text/html` |
| `/api/state` | GET | yes | Full state JSON: run + settings + sessions + logs + dataDir. | `application/json` |
| `/api/metrics` | GET | yes | Compact metrics (Prometheus-friendly). | `application/json` |
| `/api/export` | GET | yes | Full run data as downloadable JSON with `Content-Disposition`. | `application/json` (attachment) |
| `/api/health` | GET | yes | Health check for load balancers. | `{ ok, uptime, dataDir }` |
| `/api/webhooks` | GET | yes | Webhook delivery log (in-memory, per-process). Query params: `limit` (default 100), `runId` (optional). | `{ records, summary }` |
| `/api/webhooks` | DELETE | yes | Clear the in-memory delivery log. | `{ cleared: true }` |
| `/api/webhooks/replay` | POST | yes | Re-attempt failed webhook deliveries. Query param: `runId` (optional). | `{ replayed, runId }` |
| `/api/events` | GET | yes | Server-Sent Events stream. Pushes `change` events whenever state files change (polled every 1s). Keepalive ping every 15s. | `text/event-stream` |
| (any other) | any | yes | 404 Not Found. | `text/plain` |

### `/api/state`

Returns everything the dashboard HTML renders:

```json
{
  "run": { /* AutonomousRun | null */ },
  "settings": { "enabled": false, "rolloverThreshold": 0.75 },
  "sessions": [ /* SessionRecord[] */ ],
  "logs": [ /* LogRow[] — most recent 200, newest first */ ],
  "dataDir": "/home/user/.config/Goose"
}
```

### `/api/metrics`

Compact key/value summary suitable for Prometheus scraping:

```json
{
  "active": 1,
  "completed": 0,
  "stopped": 0,
  "errored": 0,
  "worker_generation": 3,
  "verification_attempt": 1,
  "context_usage_pct": 42,
  "rollover_pending": 0,
  "session_count": 4,
  "log_count": 87,
  "session_cost_cents": 35,
  "total_cost_cents": 127,
  "updated_at": "2025-01-15T12:34:56.789Z",
  "run_id": "a1b2c3d4-...",
  "phase": "working"
}
```

Each metric is a 0/1 flag (for status) or a count/percentage.

### `/api/export`

Downloads a snapshot of the entire run as a JSON file. The
`Content-Disposition` header forces a download with a filename like
`goose-autonomous-<runId-prefix>-<timestamp>.json`. Useful for filing bug
reports or sharing a run for offline analysis.

### `/api/health`

Returns `{ ok: true, uptime: <seconds>, dataDir: <path> }`. Suitable for
load-balancer liveness checks.

### `/api/webhooks`

Returns the in-memory delivery log (see §4.7). Query params:

- `limit` (default 100): max records to return.
- `runId` (optional): filter to a specific run.

Response includes a `summary` block:

```json
{
  "records": [ /* WebhookDeliveryRecord[] */ ],
  "summary": {
    "total": 42,
    "delivered": 38,
    "failed": 3,
    "skipped": 1,
    "signed": 42
  }
}
```

`DELETE /api/webhooks` clears the in-memory log and returns
`{ cleared: true }`.

### `/api/webhooks/replay`

`POST` re-delivers all failed deliveries (with stored payload + config).
Returns `{ replayed: <count>, runId: <null | runId> }`. Optional `runId`
query param filters to one run.

The endpoint waits 500ms after triggering replay so the delivery attempts
have a chance to complete before the response is sent (otherwise the
records for the new attempts may not yet be in the log).

### `/api/events`

Server-Sent Events stream. The dashboard polls state files every 1s
(via `statSync` mtime comparison); when any file changes, it emits a
`change` event. The HTML dashboard subscribes to this stream and calls
`refresh()` on every `change` event, so the UI updates instantly (not
just on the 1s polling interval).

The stream sends a `: ping` comment every 15s to keep the connection
alive through proxies.

## 7.4 Live HTML dashboard

The HTML dashboard (`/`) renders five panels in a 3-column grid:

1. **State panel** — phase, worker generation, verification attempt,
   rollover status, last error, updated time. Plus a context gauge with
   threshold marker.
2. **Original objective** — the immutable objective text.
3. **Current handoff** — the structured handoff: current state, exact
   next action, completed work, remaining work, files changed, failures,
   tests.
4. **Session timeline** — worker → verification lineage with status
   badges (active/completed/failed/abandoned).
5. **Event log** — streaming compact log with info/warn/error levels.

Auto-refreshes every 1s + instant updates via SSE. The footer shows the
live status indicator, the data dir, and a "goose-autonomous-sessions
monitor" label.

Phase labels (human-readable) shown in the UI:

| Phase | Label | Color |
| --- | --- | --- |
| `working` | Working | amber |
| `handoff` | Preparing continuation | amber |
| `creating-session` | Starting fresh session | amber |
| `verifying` | Independently verifying | emerald |
| `completed` | Completed | emerald |
| `stopped` | Stopped | muted |
| `error` | Needs attention | rose |

## 7.5 Remote monitoring (SSH tunnel)

The dashboard runs on localhost by default. To monitor a long-running
task from your laptop while it runs on a server:

```bash
# On your laptop:
ssh -L 7878:localhost:7878 user@your-server
# Then open http://localhost:7878 in your laptop's browser
```

For multi-user or public deployments, set `AUTONOMOUS_DASHBOARD_TOKEN` to
require auth.

---

# Part 8 — CLI Reference

The CLI is `cli/goose-autonomous.ts`. Run with `bun`:

```bash
bun cli/goose-autonomous.ts <command> [flags]
```

The CLI is **read-only** — it never modifies state. The only exception is
`replay`, which re-attempts failed webhook deliveries (and even that
doesn't modify the run state, only re-fires webhooks).

## 8.1 Commands

| Command | Purpose |
| --- | --- |
| `state` | Show the current run state + settings (default if no command given). |
| `logs` | Show recent event log entries. |
| `webhooks` | Show webhook delivery log (in-memory, per-process). |
| `sessions` | Show session lineage. |
| `metrics` | Show compact metrics (Prometheus-friendly). |
| `replay` | Re-attempt failed webhook deliveries. |
| `help` / `--help` / `-h` | Show usage. |

## 8.2 Flags

| Flag | Default | Applies to | Purpose |
| --- | --- | --- | --- |
| `--data-dir DIR` | `~/.config/Goose` | all commands | Override the Goose data directory. |
| `--limit N` | `50` | `logs`, `webhooks` | Number of entries to show. |
| `--run-id ID` | (none) | `webhooks`, `replay` | Filter by run ID. |

## 8.3 Command details

### `state`

Prints the data dir, autonomous enabled/disabled, rollover threshold, and
(if a run exists): runId, status, phase, worker generation, verification
attempt, context usage %, rollover pending, turns (v0.4+), total cost
(v0.5+), last error, last updated, and the original objective.

### `logs`

Reads `autonomous.log.jsonl` from the data dir, shows the last `--limit`
entries (default 50) newest-first. Each line shows timestamp, level
(colored: green info / amber warn / red error), runId prefix (dim), and
message.

### `webhooks`

Calls `getDeliveryLog(limit, runId)` — the in-memory log of the **current
process**. Note: if you run this CLI as a separate process from Goose
Desktop, the log will be empty (each process has its own log). To see
deliveries from Goose Desktop, run the CLI inside the Goose Desktop
process context, or check the dashboard's `/api/webhooks` endpoint (which
reads the dashboard process's log).

Each record shows: timestamp, event, result (colored: green delivered /
red failed / dim skipped), `signed` tag if signed, attempt number, URL,
and (on failure) the error message. Ends with a summary count.

### `sessions`

Reads `autonomous-sessions.json`, shows the session lineage: name
padded, role, status (colored), creation timestamp.

### `metrics`

Reads `autonomous-state.json` + `autonomous-sessions.json`, prints a
compact key/value block (same fields as `/api/metrics`). Prometheus-
friendly — easy to scrape with a textfile collector.

### `replay`

Calls `replayFailedDeliveries(silentLogger, runId)` — re-attempts all
failed webhook deliveries with stored payloads. Prints the count.

### `help`

Prints the command list + flag list.

## 8.4 Examples

```bash
# default — show state
bun cli/goose-autonomous.ts

# show last 100 log entries
bun cli/goose-autonomous.ts logs --limit 100

# show webhooks for a specific run
bun cli/goose-autonomous.ts webhooks --run-id a1b2c3d4-1234-...

# use a non-default data dir
bun cli/goose-autonomous.ts state --data-dir /custom/path

# replay failed webhooks for one run
bun cli/goose-autonomous.ts replay --run-id a1b2c3d4
```

---

# Part 9 — Install / Uninstall Reference

The installer (`install.sh`) and uninstaller (`uninstall.sh`) wire the
autonomous module into a local Goose Desktop source checkout.

## 9.1 Prerequisites

| Requirement | Why |
| --- | --- |
| **Linux** (x64) | v0.2 installer refuses non-Linux (`uname -s != Linux`). macOS/Windows are out of scope for v0.2. |
| **Goose Desktop source checkout** | The installer copies the autonomous module into `ui/desktop/src/` and applies patches to existing Goose files. You need a clone of `aaif-goose/goose`. |
| **git** | The installer creates a backup branch, validates patches with `git apply --check`, and applies them with `git apply`. |
| **Clean git tree** | The installer refuses to proceed if `git status --porcelain` is non-empty. Commit or stash your work first. |
| **Pinned Goose commit** | `ce0c4900837a51b2ae50ce0df1484c34a1be754e`. The installer warns (and asks) if your HEAD doesn't match; patches may not apply. |
| **Bun** (for tests/dashboard) | Optional for install, but needed to run the test suite and the dashboard. |
| **pnpm** (for `--build`) | Only needed if you pass `--build` to build the customized Desktop. |

## 9.2 `install.sh` usage

```bash
./install.sh /path/to/goose [--build]
# or:
GOOSE_SOURCE=/path/to/goose ./install.sh [--build]
```

### Flags

| Flag | Purpose |
| --- | --- |
| (positional 1) | Path to the Goose source checkout (or set `GOOSE_SOURCE` env var). Required. |
| `--build` | After installation + patching, run `pnpm install` + `pnpm build` in `ui/desktop/`. Optional. |

### What the installer does (12 steps)

1. **Verify Linux** — refuse if not Linux.
2. **Locate Goose source** — required positional arg or `GOOSE_SOURCE`.
3. **Verify Goose layout** — `ui/desktop/src/` must exist.
4. **Verify git + clean tree** — `git status --porcelain` must be empty.
5. **Verify pinned commit** — read `patches/PINNED_COMMIT`; if Goose HEAD
   doesn't match, warn and prompt `[y/N]`.
6. **Create backup branch** — `goose-autonomous-sessions/<timestamp>` (so
   uninstall can restore).
7. **Validate patches** — run `patches/validate.sh /path/to/goose`, which
   runs `git apply --check` for each patch in series. If any fail, abort
   cleanly (no changes applied).
8. **Install the autonomous module** — copy `src/autonomous/*.ts` to
   `ui/desktop/src/autonomous/`; copy `adapters/*.ts` to
   `ui/desktop/src/adapters/`. Overwrite if already present (with a
   warning).
9. **Create the controller singleton** — write
   `ui/desktop/src/autonomous/index.ts` that wires
   `AutonomousSessionController` to the Electron + ACP adapters.
10. **Apply the patches** — `git apply --whitespace=fix <patch>` for each
    patch in `patches/SERIES` order. Abort on first failure.
11. **Optionally build** — if `--build`, run `pnpm install` + `pnpm build`
    in `ui/desktop/`.
12. **Print summary** — Goose source, backup branch, pinned commit,
    installed file counts, patch count, build status, next steps.

### What gets installed where

| Source (in this repo) | Destination (in Goose source) | Contents |
| --- | --- | --- |
| `src/autonomous/*.ts` | `ui/desktop/src/autonomous/` | The portable controller module (12 files: types, constants, controller, handoff, handoff-schema, rollover-policy, webhooks, recovery, completionDetector, sessionManager, navigation, contextMonitor, logger, stateStore). |
| `adapters/*.ts` | `ui/desktop/src/adapters/` | Goose-specific adapters (3 files: electron-state-store, electron-logger, acp-integration). |
| `patches/0001-*` … `patches/0005-*` | applied in-place to: `ui/desktop/src/constants/events.ts`, `ui/desktop/src/utils/settings.ts`, `ui/desktop/src/hooks/useChatSession.ts`, `ui/desktop/src/hooks/useNavigationSessions.ts`, `ui/desktop/src/main.ts`, `ui/desktop/src/preload.ts` | 5 minimal patches. Total: 6 files touched, 134 lines added, 0 removed. |
| (auto-generated) | `ui/desktop/src/autonomous/index.ts` | The wired controller singleton. |

## 9.3 The pinned commit

```
ce0c4900837a51b2ae50ce0df1484c34a1be754e
```

- Repo: [`aaif-goose/goose`](https://github.com/aaif-goose/goose)
- Branch: `main`
- Path: `ui/desktop/src/`
- Commit message: `fix(anthropic): forward unknown request_params to wire,
  mirroring openai engine (#12720)`

The pinned SHA is recorded in `patches/PINNED_COMMIT`. The installer and
`validate.sh` both read this file. To check out the exact pinned commit:

```bash
cd /path/to/goose
git fetch origin ce0c4900837a51b2ae50ce0df1484c34a1be754e
git checkout ce0c4900837a51b2ae50ce0df1484c34a1be754e
```

## 9.4 Patch validation

`patches/validate.sh` independently verifies that the 5 patches apply
cleanly against the pinned commit. Usage:

```bash
# against a real Goose checkout:
./patches/validate.sh /path/to/goose

# or self-test (clones the pinned commit into a temp dir):
./patches/validate.sh
```

What it does:

1. Resolve `GOOSE_SOURCE` (positional arg or env var). If empty, run
   self-test: shallow-clone `aaif-goose/goose` at the pinned commit into
   a temp dir.
2. Verify `GOOSE_SOURCE` is a directory and contains `ui/desktop/src/`.
3. Verify `git rev-parse HEAD` matches `PINNED_COMMIT` (after resolving
   the SHA via `git rev-parse`). Refuse if not.
4. Warn (not refuse) if the tree is dirty.
5. For each of the 5 patches, run `git apply --check --verbose` (dry-run)
   and report PASS/FAIL.
6. Exit 0 if all pass, 2 if any fail, 1 if preconditions fail.

The installer calls `validate.sh` as step 7 and aborts the install if
validation fails — so the patches are guaranteed to apply before any
changes are made to your Goose source.

## 9.5 The 5 patches

| # | Patch | Goose file(s) | What it adds |
| --- | --- | --- | --- |
| 0001 | `0001-add-autonomous-event.patch` | `constants/events.ts` | `GOOSE_AUTONOMOUS_SWITCH_SESSION` member of the `AppEvents` enum. |
| 0002 | `0002-add-settings-field.patch` | `utils/settings.ts` | The `AutonomousSettings` interface, the `Settings.autonomous` field, and `defaultSettings.autonomous`. |
| 0003 | `0003-wire-useChatSession.patch` | `hooks/useChatSession.ts` | Import of `autonomousController`, a `useEffect` reporting context usage (`accumulatedTotalTokens` → `used`, `contextLimit` → `limit`), and an `onTurnFinished(...)` call at the top of `onFinish` (before any existing logic; wrapped in try/catch so it never throws into Goose's chat path). |
| 0004 | `0004-wire-navigation.patch` | `hooks/useNavigationSessions.ts` | A `useEffect` listening for `GOOSE_AUTONOMOUS_SWITCH_SESSION` events and routing the renderer to the new session id. |
| 0005 | `0005-add-electron-ipc.patch` | `main.ts` + `preload.ts` | 5 `ipcMain.handle` registrations (`autonomous:get-state`, `set-state`, `clear-state`, `get-settings`, `set-settings`), 5 corresponding `electronAPI` methods in preload, and `'autonomous'` added to `validSettingKeys` so the existing `set-setting` IPC accepts the new field. |

Each patch is minimal — just the import and the hook call(s). No Goose
logic is rewritten. Total diff: 6 files touched, 134 lines added, 0
removed.

## 9.6 `uninstall.sh` usage

```bash
./uninstall.sh /path/to/goose
# or:
GOOSE_SOURCE=/path/to/goose ./uninstall.sh
```

What it does:

1. Resolve `GOOSE_SOURCE`.
2. Verify the source dir exists.
3. `cd` into it. Check for `ui/desktop/src/autonomous/`. If missing, log
   "nothing to uninstall" and exit 0.
4. Find the most recent backup branch matching
   `goose-autonomous-sessions/*`.
5. If found:
   - `git checkout <backup-branch>` (returns to the pre-install commit).
   - `git checkout -- .` (revert any working-tree changes from the
     patches).
   - `rm -rf ui/desktop/src/autonomous ui/desktop/src/adapters` (remove
     the untracked module + adapter dirs).
   - Print summary: source, restored-from branch, module removed,
     adapters removed, "autonomous state: preserved (in app-data)".
6. If no backup branch:
   - `rm -rf` the module + adapter dirs.
   - `git checkout --` the 6 patched tracked files (best-effort).
   - Warn that no backup branch was found and the user should review with
     `git status`.

**What is preserved on uninstall:**

- Goose data (sessions, settings, etc.) — untouched.
- Normal Goose sessions — untouched.
- Autonomous state files (`autonomous-state.json`,
  `autonomous-settings.json`, `autonomous-sessions.json`,
  `autonomous.log.jsonl` in app-data) — untouched. The user can inspect
  or delete these manually.

**What is removed on uninstall:**

- `ui/desktop/src/autonomous/` directory.
- `ui/desktop/src/adapters/` directory.
- The 6 patched tracked files are reverted to their pre-install state
  (via the backup branch).

To delete the backup branch after a successful uninstall:

```bash
git branch -D goose-autonomous-sessions/<timestamp>
```

---

# Part 10 — Workflows & Best Practices

## 10.1 The "walk away" workflow

The canonical use case.

1. **Install** the autonomous module into your Goose source:
   `./install.sh /path/to/goose --build`
2. **Launch** the customized Goose Desktop.
3. **Open Settings** → enable **Autonomous Sessions**.
4. **Set the rollover threshold** (default 75% is fine for most models;
   see §10.2 for tuning guidance).
5. **Start a long-running task**. Type the objective as if you were
   talking to a developer who will be left alone for 12 hours:
   "Refactor the auth module to use the new session API. Update all
   call sites. Add tests for the new flow. Make sure `bun test` passes.
   Don't change the public API surface."
6. **Optionally configure webhooks** so you get notified on completion
   or failure. At minimum, subscribe to `run.completed`, `run.failed`,
   and `budget.exhausted`.
7. **Optionally set `maxTotalCostCents`** if you want a hard ceiling on
   spend while you're away.
8. **Optionally start the dashboard** (`bun dashboard/server.ts`) in a
   terminal so you can peek at progress.
9. **Walk away.** Sleep. Cook. Go for a run.
10. **Come back** to either:
    - A `completed` run with independently-verified work.
    - A `stopped` run (if you stopped it) — `resumeRun()` to continue.
    - An `error` run — read `lastError`, inspect the dashboard, decide
      whether to `clearAll` and start fresh or fix and resume.
11. **Inspect the audit trail**: session lineage (in the dashboard or via
    `bun cli/goose-autonomous.ts sessions`), the final handoff (in the
    dashboard's "Current Handoff" panel), the event log (in the dashboard
    or via the CLI).

## 10.2 Choosing a rollover threshold

The default `0.75` (75%) is a reasonable starting point. Adjust:

| Situation | Recommended threshold | Why |
| --- | --- | --- |
| Modern long-context model (Claude Sonnet 4.5, GPT-4o, etc.) | `0.75`–`0.85` | These models handle long context well; lower thresholds waste handoff-generation overhead. |
| Older / smaller context model | `0.6`–`0.7` | These models degrade sooner; rollover before performance drops. |
| Reproducibility / debugging | `0.5` | Smaller sessions are easier to inspect; trade-off is more rollovers. |
| Model that gets "stuck" near the limit | `0.6` | If you see the worker emit low-quality turns when context is full, lower the threshold. |
| Very expensive model | `0.85` | Fewer rollovers = fewer handoff-generation calls = lower cost. Trade-off is higher per-session cost. |

**Combining with other policies.** The context policy is best combined
with a turn or time cap as a safety net. For example:

```json
{
  "rolloverThreshold": 0.75,
  "rolloverPolicy": {
    "contextPercent": 0.75,
    "maxTurnsPerSession": 50,
    "maxMinutesPerSession": 60
  }
}
```

This configuration: rolls over at 75% context (the primary trigger), but
also rolls over if a session somehow runs 50 turns (reproducibility) or
60 minutes (safety against stalls).

## 10.3 Turn-based vs time-based vs cost-based rollover

| Policy | When to use | When **not** to use |
| --- | --- | --- |
| `contextPercent` (default) | Most situations. The only policy that directly addresses the underlying problem (running out of context). | When context measurement is unreliable for your provider. |
| `maxTurnsPerSession` | Reproducibility (every session is exactly N turns). When context measurement is unreliable. When you want predictable session sizes for benchmarking. | When sessions legitimately vary in length (some tasks need 5 turns, some need 30). Wastes context on short sessions. |
| `maxMinutesPerSession` | Bounding session latency (for predictable monitoring). As a safety net against stalls (the model enters a slow loop). | When tasks have legitimate long-running phases (build waits, test waits). The timer doesn't distinguish active work from idle wait. |
| `maxCostCentsPerSession` | Bounding per-session spend. Useful when individual sessions sometimes spiral on a hard sub-problem. | When you only care about total run spend — `maxTotalCostCents` is the right tool for that. |

**OR semantics.** All enabled policies are combined with OR — any one
tripping marks rollover pending. There's no "AND" mode (e.g. "roll over
only when context AND turns are both high"). If you need that, leave the
more permissive policy disabled and rely on the stricter one.

**Priority on tripping.** When multiple policies trip simultaneously, the
controller records the first one in this order: `context` → `turns` →
`time` → `cost`. (See `evaluateRollover` in `rollover-policy.ts`.) The
`rolloverReason` field on the run reflects which one tripped.

## 10.4 When to set a verification budget

Set `maxVerificationAttempts` when:

- You are running overnight / unattended and want a hard guarantee
  against infinite verify→fail loops.
- The task is genuinely hard and you expect some verification failures —
  set the budget to the number of attempts you're willing to fund.
- You want the run to terminate in `error` rather than burn credits
  indefinitely.

Leave `maxVerificationAttempts` unset when:

- You are running interactively and want to retry as many times as it
  takes.
- The task is small and you're confident in 1–2 attempts.

Typical values:

| Task scope | Recommended |
| --- | --- |
| Small (1–2 hours of work) | `2`–`3` |
| Medium (half-day) | `3`–`4` |
| Large (full-day or multi-day) | `4`–`6` |
| Open-ended research | unset (unlimited) |

## 10.5 When to set a cost budget

Set `maxTotalCostCents` whenever you are running unattended and want a
hard ceiling on spend. The controller will halt the run in `error` phase
if `totalCostCents >= maxTotalCostCents`.

| Use case | Recommended |
| --- | --- |
| Overnight run, small task | `500` ($5) |
| Overnight run, medium task | `2000` ($20) |
| Overnight run, large task | `10000` ($100) |
| Interactive run (you're watching) | unset |

Distinct from `rolloverPolicy.maxCostCentsPerSession`: that triggers a
rollover (per-session), this halts the entire run (total).

The two can be combined:

```json
{
  "maxTotalCostCents": 5000,
  "rolloverPolicy": { "maxCostCentsPerSession": 200 }
}
```

This means: no single session may cost more than $2 (rolls over); the
entire run may not exceed $50 (halts).

## 10.6 Webhook best practices

### When to use HMAC

Always set `secret` when delivering to:

- Public URLs (HTTPS endpoints reachable from the internet).
- Any URL not behind your own auth.
- Multi-tenant services (where one customer's webhook could be spoofed
  against another).

You can omit `secret` for:

- Local-network delivery (e.g. to a localhost dev server).
- URLs behind your own auth (e.g. an internal service that requires
  session auth).

### When to filter events

Set `events` when:

- The receiver only cares about specific events (e.g. Slack alerts for
  `run.completed` + `run.failed` only).
- The receiver is a queue/topic that has its own routing (avoid
  fan-out spam).
- You want to reduce receiver load / log noise.

Leave `events` unset when:

- The receiver is an audit log that should record everything.
- The receiver is a dashboard / monitor that wants all state changes.

### Retry tuning

| Receiver profile | Recommended retry |
| --- | --- |
| Slack / Discord webhook | `{ maxAttempts: 3, backoffMs: 2000, backoffStrategy: 'exponential', jitter: true }` (these services have rate limits) |
| Custom HTTP endpoint (your own server) | `{ maxAttempts: 5, backoffMs: 5000, backoffStrategy: 'exponential', jitter: true }` |
| Localhost dev server | `{ maxAttempts: 1 }` (no retry — fail fast, see errors immediately) |
| Serverless function (e.g. AWS Lambda) | `{ maxAttempts: 3, backoffMs: 1000, backoffStrategy: 'fixed', jitter: true }` |
| Audit log (must not lose events) | `{ maxAttempts: 10, backoffMs: 5000, backoffStrategy: 'exponential', jitter: true }` |

### Receiver implementation checklist

A robust webhook receiver should:

1. Read the **raw body** (not `req.json()`) for HMAC verification —
   re-serializing JSON can change whitespace and break the signature.
2. Verify the signature with `verifySignature(secret, body,
   signature)` before doing anything else. Return 401 on mismatch.
3. Return 2xx **only** when the event is fully processed. If you return
   2xx before processing and the processing fails, the event is lost.
   If you return 5xx, the controller will retry.
4. Be idempotent. The controller doesn't guarantee exactly-once delivery
   (the network can fail between the receiver's 2xx and the controller
   recording the delivery as `delivered`). Use `payload.runId` +
   `payload.event` + `payload.emittedAt` as a deduplication key.
5. Process asynchronously if your work is slow. The controller's
   `fetch()` has a 5-second timeout — if your processing takes longer,
   return 202 (Accepted) immediately and process in the background.

## 10.7 Crash recovery best practices

- **Always run `recover()` at host startup.** Even if the previous run
  was clean, recovery is a no-op when there's no run. The cost is one
  `getRun()` call.
- **Don't manually edit `autonomous-state.json` while a run is active.**
  The controller reads/writes it on every event; concurrent edits can
  race. Use `stopRun()` first if you need to inspect.
- **After a crash, inspect the dashboard before resuming.** Look at the
  phase, the last log entries, and the current handoff. Recovery may
  have reset to `working` with `rolloverPending=true` — that's normal
  and the next turn will re-roll.
- **If recovery leaves the run in `error`** (e.g. the persisted state is
  genuinely corrupted, or the run was in `error` before the crash),
  `clearAll()` and start fresh. Don't try to manually patch the state
  file.
- **Test recovery in a controlled way.** Kill the Goose Desktop process
  (via `kill -9` or Activity Monitor) mid-run, then restart. Verify the
  dashboard shows the run resuming correctly.

## 10.8 Stop vs crash — when each is appropriate, what each preserves

| Action | When appropriate | What it does | What it preserves |
| --- | --- | --- | --- |
| `stopRun()` | You want to pause the run intentionally — e.g. to inspect, to free up the model for another task, to apply a Goose update. | Sets `phaseBeforeStop`, `status='stopped'`, `phase='stopped'`. Emits `run.stopped`. | Everything: run record, handoff, sessions, logs, settings. `resumeRun()` restores. |
| Crash (process killed) | Unintentional — power loss, OOM kill, manual `kill -9`. | Leaves the persisted state as-is. `recover()` on next startup reconciles. | Everything that was persisted up to the last `saveRun` call. Some in-flight state (e.g. a handoff-generation prompt in progress) is lost — recovery resets to a safe re-trigger point. |

**Key difference.** `stopRun()` is a clean, intentional pause — the run
enters a terminal-ish state that can be resumed. A crash leaves the run
in whatever phase it was in; recovery reconciles (possibly resetting
mid-rollover phases to `working` with `rolloverPending=true`).

**When to use stop.** Always prefer `stopRun()` over killing the process
when you have the choice. It's safer, it's recoverable, and it emits a
`run.stopped` webhook so your monitoring knows.

## 10.9 Custom handoff schema — when to use, what to add

Use a custom handoff schema when:

- Your task domain has structured information that doesn't fit the 9
  default fields (e.g. a `securityReview` field for security-sensitive
  tasks, `breakingChanges` for library work, `performanceBenchmarks`
  for optimisation work).
- You want to tighten constraints on built-in fields (e.g. lower
  `maxLen` for `currentState` to force the LLM to be more concise).
- You want to remove built-in fields (mark them as not required — though
  the controller's `coerceToHandoff` always populates them with defaults
  if missing, so the `Handoff` interface remains consistent).

**What to add.** Each custom field should be:

- **Specific.** "list of breaking API/behavior changes" beats "changes".
- **Bounded.** Set `maxItems` and `itemMax` to keep the handoff prompt-
  sized.
- **Useful to the next session.** If the next session won't read it,
  don't add it (it just bloats the prompt).

**Examples.**

A security-focused schema:

```ts
const schema = createHandoffSchema(defaultHandoffSchema(), [
  {
    name: 'securityReview',
    type: 'string',
    required: false,
    description: 'brief security review note — threats considered, mitigations applied, residual risk',
    maxLen: 2000,
    label: 'SECURITY REVIEW',
  },
  {
    name: 'threatsAddressed',
    type: 'string[]',
    required: false,
    description: 'list of specific threats addressed in this session (e.g. "XSS in user input field")',
    maxItems: 32,
    itemMax: 200,
    label: 'THREATS ADDRESSED',
  },
]);
```

A library-refactor schema:

```ts
const schema = createHandoffSchema(defaultHandoffSchema(), [
  {
    name: 'breakingChanges',
    type: 'string[]',
    required: true,
    description: 'list of breaking API/behavior changes (consumers must update)',
    maxItems: 32,
    itemMax: 500,
    label: 'BREAKING CHANGES',
  },
  {
    name: 'migrationGuide',
    type: 'string',
    required: false,
    description: 'brief migration guide for consumers (how to update their code)',
    maxLen: 2000,
    label: 'MIGRATION GUIDE',
  },
]);
```

A performance-optimisation schema:

```ts
const schema = createHandoffSchema(defaultHandoffSchema(), [
  {
    name: 'benchmarks',
    type: 'test[]',
    required: true,
    description: 'performance benchmarks run before and after (use command field for the bench command, result for PASS/FAIL/UNKNOWN, details for the measurement)',
    maxItems: 32,
    label: 'BENCHMARKS',
  },
]);
```

**Wiring.** Pass the schema to the controller constructor:

```ts
const controller = new AutonomousSessionController({
  // ... other deps
  handoffSchema: schema,
});
```

The controller then uses `buildHandoffPromptFromSchema`,
`parseHandoffResponseWithSchema`, `isValidHandoffAgainstSchema`,
`serializeHandoffWithSchema`, and `coerceToHandoff` for all handoff
operations. Custom fields appear after the built-ins in the serialized
handoff (in schema order).

## 10.10 Monitoring — dashboard vs CLI vs API

| Tool | When to use | Pros | Cons |
| --- | --- | --- | --- |
| **Dashboard (HTML)** | Live monitoring at your desk. | Visual, auto-refreshing, shows everything in one view. | Requires a browser tab open. |
| **Dashboard (API)** | Programmatic monitoring, scraping into Prometheus/Grafana. | JSON, stable schema, auth-able. | No visualisation — you build your own. |
| **CLI `state`** | Quick one-off check from a terminal. | Fast, no browser. | Snapshot only — no live updates. |
| **CLI `logs`** | Investigating a specific past event. | Filterable by limit. | Reads from the persisted log file (capped at 500 rows). |
| **CLI `metrics`** | Prometheus textfile collector scraping. | Compact, parseable. | Same data as `/api/metrics`. |
| **CLI `sessions`** | Inspecting session lineage. | Shows parent/child relationships, statuses. | Snapshot only. |
| **CLI `webhooks`** | Debugging webhook delivery. | Shows per-process delivery log. | In-memory, per-process — may be empty when run from a separate process. |
| **CLI `replay`** | Re-delivering failed webhooks. | Idempotent, doesn't affect run state. | Only replays failures with stored payloads (v0.9+ records). |
| **SSH tunnel + dashboard** | Monitoring a remote run from your laptop. | Visual, no extra setup. | Requires SSH access to the server. |

## 10.11 Troubleshooting

### "The run is stuck in `working` phase with no progress."

- **Check the dashboard's event log.** The last few entries should tell
  you what the controller is doing.
- **Check `turnsInCurrentSession`** in the state view. If it's
  incrementing, the worker is doing turns — just slow. If it's stuck at
  the same value, the worker may be stuck (model not responding).
- **Check the Goose Desktop process.** Is it consuming CPU? Is the model
  provider reachable?
- **If genuinely stuck**, `stopRun()` then `resumeRun()` to reconnect.
  If that doesn't help, `clearAll()` and restart.

### "The run keeps failing verification (`verification.failed` repeatedly)."

- **Inspect the verifier's findings** (in the dashboard's handoff panel
  after a FAIL — `remainingWork` will be the findings).
- **Check the verifier's session directly** in Goose Desktop — read what
  it actually said. The findings extraction heuristic (`extractFindings`)
  only catches lines after `AUTONOMOUS_VERIFICATION: FAIL` that look like
  findings.
- **Set `maxVerificationAttempts`** to bound the loop if it's clearly
  not converging.
- **Consider revising the objective.** If the verifier keeps finding
  problems, the task may be genuinely hard and need to be broken down.

### "Webhooks aren't being delivered."

- **Check the delivery log** (`bun cli/goose-autonomous.ts webhooks` or
  `GET /api/webhooks`). Records with `result='failed'` will have an
  `error` message.
- **Verify the URL is reachable** from the Goose Desktop process. A
  localhost URL won't be reachable from a Docker container.
- **Verify the secret matches** if you set one. The receiver should use
  `verifySignature` with the same secret.
- **Check the receiver's logs.** The controller's 5-second timeout may
  be too short if your receiver is slow.
- **Use `replay`** to re-deliver failed events after fixing the
  receiver: `bun cli/goose-autonomous.ts replay`.

### "Webhook deliveries are being skipped."

- You have `events` filtering on. Check the `WebhookConfig.events`
  allowlist — the event type must be in the list to be delivered.
- Skipped deliveries are recorded with `result='skipped'` for
  visibility. They are **not** retried.

### "The dashboard shows no live updates."

- **Check the SSE stream**. Open your browser's dev tools, Network tab,
  look for the `EventSource` connection to `/api/events`. It should be
  open and receiving `change` events.
- **Check the data dir**. The dashboard polls state files every 1s. If
  the Goose data dir is set to a non-default location, set
  `AUTONOMOUS_DATA_DIR` when starting the dashboard.
- **Check the Goose Desktop process is writing state files.** Look at
  the modification time of `~/.config/Goose/autonomous-state.json` — it
  should be recent.

### "Recovery keeps resetting to `working` with `rolloverPending=true`."

- This is the expected behaviour when the run was in `handoff` or
  `creating-session` phase when the crash occurred. The controller
  intentionally resets to a safe re-trigger point.
- The next turn-finish will re-attempt the rollover. If the worker is
  still alive (the host owns the live session), it will produce a
  handoff and the rollover will proceed.
- If the worker is **not** still alive (e.g. the Goose Desktop session
  was closed), you may need to manually start a new worker session. In
  practice this is rare — Goose Desktop preserves sessions across
  restarts.

### "Handoff generation keeps failing."

- **Inspect the model's handoff responses.** They may be malformed JSON,
  missing required fields, or exceeding length limits.
- **Check the controller's log** for `handoff parse/validation failed
  (attempt N)` entries.
- **Consider tightening or loosening the schema.** If you have a custom
  schema with strict constraints, the model may struggle to satisfy
  them. Loosen `maxLen` / `maxItems` / `itemMax`.
- **Try a different model.** Some models are better at structured JSON
  output than others.

### "The dashboard's webhook log is empty."

- The webhook delivery log is **in-memory and per-process**. The
  dashboard process and the Goose Desktop process have **separate**
  logs.
- The dashboard's log only shows deliveries triggered by the dashboard
  process itself (rare). To see Goose Desktop's deliveries, watch the
  Goose Desktop logs (or set up webhooks to a receiver that logs them).

### "The cost budget tripped but `totalCostCents` is wrong."

- `totalCostCents` accumulates from `AgentTurn.costCents`, which the
  host reports on every `onTurnFinished`. If the host doesn't report
  `costCents` (the field is optional), the budget will never trip.
- In Goose Desktop, the `useChatSession` patch should report
  `costCents` if the ACP `TokenState` includes cost data. Check the
  patch and the ACP version.

---

# Part 11 — Type Reference

A quick-reference table of every exported type with a one-line
description. All types are exported from `src/autonomous/index.ts`.

## 11.1 Phases, statuses, and primitives

| Type | Description |
| --- | --- |
| `AutonomousPhase` | Union: `'working' \| 'handoff' \| 'creating-session' \| 'verifying' \| 'completed' \| 'stopped' \| 'error'`. The current phase of the state machine. |
| `AutonomousRunStatus` | Union: `'active' \| 'completed' \| 'stopped' \| 'error'`. The overarching status of the run. |
| `AutonomousPromptOrigin` | Union: `'user' \| 'continuation' \| 'verification' \| 'handoff'`. Where a prompt came from. |
| `SessionRole` | Union: `'worker' \| 'verification'`. The role a session plays in a run. |
| `WorkerStatus` | Union: `'complete' \| 'continue' \| 'unknown'`. The classification of a worker's last message. |
| `VerificationStatus` | Union: `'pass' \| 'fail' \| 'unknown'`. The classification of a verifier's last message. |
| `TransitionStage` | Union: `'handoff-saved' \| 'session-created' \| 'prompt-sent' \| 'session-active'`. Fine-grained progress within a rollover/verification transition. |
| `RolloverReason` | Union: `'context' \| 'turns' \| 'time' \| 'cost'`. Which policy tripped. |

## 11.2 Handoff types

| Type | Description |
| --- | --- |
| `HandoffTest` | `{ command?: string; result: 'PASS' \| 'FAIL' \| 'UNKNOWN'; details?: string }`. One test entry in the handoff's `tests` array. |
| `Handoff` | The 10-field structured handoff object. See §1.3. |
| `HandoffFieldType` | Union: `'string' \| 'string[]' \| 'test[]'`. The type of a `HandoffField`. |
| `HandoffField` | One field definition in a `HandoffSchema`. See §2.5. |
| `HandoffSchema` | `HandoffField[]`. The full schema for handoff generation/validation/serialization. |

## 11.3 Run + session types

| Type | Description |
| --- | --- |
| `AutonomousRun` | The full run record. ~30 fields including status, phase, objective, session ids, generation counters, handoff, costs, timestamps. See `types.ts`. |
| `SessionRecord` | One entry in the session lineage: `{ sessionId, runId, role, generation, parentSessionId?, name, status, objective, handoffJson?, createdAt, updatedAt }`. |
| `AgentTurn` | Compact transcript line for a model turn: `{ sessionId, turnIndex, role, summary, filesTouched, testsRun, contextBefore, contextAfter, statusMarker?, ts, costCents? }`. Passed to `onTurnFinished`. |
| `LogEntry` | One log row: `{ id, ts, level, runId?, message }`. |
| `AutonomousOperation` | `{ type: 'continuation' \| 'verification' \| 'handoff'; runId; sessionId }`. (Reserved for future use.) |

## 11.4 Settings + policy types

| Type | Description |
| --- | --- |
| `AutonomousSettings` | The top-level settings object. See §2.1. |
| `RolloverPolicy` | The 4-field rollover policy. See §2.2. |
| `WebhookConfig` | One webhook destination. See §2.3. |
| `WebhookRetryPolicy` | Per-webhook retry policy. See §2.4. |
| `WebhookEvent` | Union of the 10 event types. See §4.1. |
| `WebhookPayload` | The payload shape delivered to every webhook. See §4.2. |
| `WebhookDeliveryRecord` | One entry in the in-memory delivery log. See §4.7. |

## 11.5 Adapter interfaces

| Type | Description |
| --- | --- |
| `StateStoreAdapter` | Persistence seam. 9 methods: `getRun`, `saveRun`, `clearRun`, `getSettings`, `saveSettings`, `recordSession`, `updateSessionStatus`, `getSessions`, `clearSessions`. |
| `LoggerAdapter` | Logging seam. 3 methods: `info`, `warn`, `error` — each `(message, runId?) => Promise<void>`. |

## 11.6 Controller types

| Type | Description |
| --- | --- |
| `AutonomousSessionController` | The main controller class. Public methods: `startRun`, `getState`, `stopRun`, `resumeRun`, `clearAll`, `onContextUsage`, `onTurnFinished`. Readonly fields: `store`, `logger`, `handoffSchema`. |
| `ControllerDeps` | Constructor argument. 7 fields: `store`, `logger`, `generateHandoffResponse`, `sendPrompt`, `handoffSchema?`, `settings?`, `webhookNotifier?`. See §2.6. |
| `HandoffGenerator` | Strategy type for `generateHandoffResponse`. `(input: { sessionId, objective, prompt }) => Promise<string \| null>`. |
| `ContinuationPromptSender` | Strategy type for `sendPrompt`. `(input: { sessionId, prompt, origin }) => Promise<void>`. |
| `WebhookNotifier` | Function type: `(payload: WebhookPayload) => Promise<void>`. Built by `createWebhookNotifier()`; overridable via `ControllerDeps.webhookNotifier`. |

## 11.7 Recovery

| Type | Description |
| --- | --- |
| `recover` (function) | `(controller: AutonomousSessionController) => Promise<AutonomousRun \| null>`. Module-level function in `recovery.ts`. Called on host startup to reconcile persisted state with the live process. See §5.8 and §6.7. |

---

<div align="center">

— end of handbook —

</div>
