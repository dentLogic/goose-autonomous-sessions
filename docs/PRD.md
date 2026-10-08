# PRD — `goose-autonomous-sessions`

> A global autonomous-session controller for Goose Desktop.

**Status:** Reference implementation complete. Source: `src/autonomous/*` (portable TypeScript).
Spec target: Goose Desktop (Electron + React, ACP-based).

---

## 1. Product summary

`goose-autonomous-sessions` is a customization of Goose Desktop that turns a single
user instruction into a long-running, self-continuing engineering task. The user
starts a normal Goose session and walks away. The controller monitors context usage,
rolls the task over into fresh sessions as needed, structures handoffs between them,
independently verifies the work, and recovers transparently from crashes — all
without a CLI daemon, a cloud service, or any per-project configuration.

The user-facing surface is intentionally tiny: one checkbox in Desktop settings
("Enable Autonomous Sessions") and one slider (rollover threshold, default 75%).
Everything else is automatic.

---

## 2. The problem

A Goose session is, by design, a bounded conversation. A long task — "refactor the
auth layer and update all callers," "migrate this service off framework X," "land
this RFC" — eventually exhausts the model's context window. When that happens the
agent degrades in one of three predictable ways:

1. it forgets earlier decisions and contradicts itself,
2. it stops seeing the original objective and drifts, or
3. it simply fails when the next prompt no longer fits.

Today, the only mitigation is manual: the user watches context climb, opens a new
session, and pastes a summary. This is fragile, error-prone, and breaks the
"start a task and walk away" workflow that autonomous agents should support.

---

## 3. Goals

| # | Goal |
| - | ---- |
| G1 | **Automatic rollover** — when context crosses a threshold, the controller rolls the task into a fresh session, no user action required. |
| G2 | **Fresh sessions** — every rollover creates a brand-new ACP session via `session/new`. No fork, no `session/load`, no copied conversation history. |
| G3 | **Structured handoffs** — continuity between sessions is a compressed structured object, not a chat transcript. |
| G4 | **Independent verification** — when a worker declares the task complete, a fresh verifier session inspects the repository and rules PASS/FAIL. |
| G5 | **Crash recovery** — persistent state survives Desktop restarts; recovery is idempotent and never guesses. |
| G6 | **Global configuration** — one enable flag and one threshold; lives in Desktop settings, not per-project. |
| G7 | **Desktop-first** — runs inside Electron; no CLI to launch, no daemon to supervise. |
| G8 | **No cloud** — no remote orchestration, no remote model calls, no telemetry. Everything is local. |

---

## 4. The handoff format

The handoff is the **only** state that crosses a session boundary. It is a
structured JSON object, validated before acceptance:

```ts
type Handoff = {
  objective: string;        // immutable copy of the run's original objective
  currentState: string;     // what is true right now about the work
  completedWork: string[];  // specific completed implementation items
  remainingWork: string[];  // outstanding work items
  filesChanged: string[];   // relevant file paths created/modified/deleted
  tests: {
    command?: string;
    result: 'PASS' | 'FAIL' | 'UNKNOWN';
    details?: string;
  }[];
  failures: string[];       // known failures, errors, regressions, blockers
  decisions: string[];      // architectural/implementation decisions made
  constraints: string[];     // requirements that must not be changed
  nextAction: string;        // the single most important next action
  generatedAt: string;      // ISO timestamp
};
```

Field-level length caps keep the serialized form under ~8–12 KB. An empty
`nextAction` is rejected. The handoff is serialized into a compact text block for
prompt embedding; the structured form is what gets persisted.

---

## 5. The state machine

```text
                startRun(user message)
                         │
                         ▼
                      WORKING ◄────────────────────────┐
                         │                              │
        context ≥ threshold                              │
                         │                              │
                         ▼                              │
                 rolloverPending = true                 │
                         │                              │
                  current turn finishes                 │
                         │                              │
                         ▼                              │
                      HANDOFF                           │
                         │                              │
                  handoff validated                     │
                         │                              │
                         ▼                              │
                 CREATING_SESSION                       │
                         │                              │
                  fresh ACP session                     │
                  continuation prompt                   │
                         │                              │
                         ▼                              │
                      WORKING ─────────────────────────┘
                         │
              AUTONOMOUS_STATUS: COMPLETE
                         │
                         ▼
                     VERIFYING
                         │
                ┌────────┴────────┐
                │                 │
       AUTONOMOUS_VERIFICATION   AUTONOMOUS_VERIFICATION
              : PASS                : FAIL
                │                 │
                ▼                 ▼
            COMPLETED        fresh WORKER
                              (verifier findings
                               become next handoff)
                                  │
                                  └──► WORKING ──► ...
```

User `Stop` and unexpected errors are terminal transitions to `stopped` and `error`
respectively.

---

## 6. Acceptance criteria

| ID | Criterion |
| -- | --------- |
| AC-1 | With Autonomous Sessions disabled, Goose Desktop behaves exactly as before. |
| AC-2 | Enabling the feature does not start a run; a user message begins the run. |
| AC-3 | Context usage at 74% does **not** mark rollover pending; 75% does. |
| AC-4 | Marking rollover pending does not interrupt the current turn. |
| AC-5 | On turn finish with `rolloverPending=true`, the controller enters `handoff` phase. |
| AC-6 | The handoff is a structured object validated against §4; invalid handoffs are rejected. |
| AC-7 | A fresh ACP session is created via `session/new` (never `session/fork`, never `session/load`). |
| AC-8 | The continuation prompt contains the original objective + serialized handoff only. |
| AC-9 | Desktop automatically navigates to the new session via a dedicated event. |
| AC-10 | The new session's context usage starts at 0%. |
| AC-11 | `AUTONOMOUS_STATUS: COMPLETE` (exact line match) triggers verification. |
| AC-12 | `AUTONOMOUS_STATUS: CONTINUE` keeps the worker in `working`. |
| AC-13 | The verification session is fresh and receives only objective + final handoff. |
| AC-14 | `AUTONOMOUS_VERIFICATION: PASS` ends the run; global enabled flag stays on. |
| AC-15 | `AUTONOMOUS_VERIFICATION: FAIL` spins a new worker with the verifier's findings as the next handoff. |
| AC-16 | The verifier never spawns another verifier (anti-loop). |
| AC-17 | After a Desktop crash/restart, `recover()` resumes an in-flight run without duplication. |
| AC-18 | User `Stop` ends the active run but leaves the global enable flag unchanged. |
| AC-19 | No CLI command is required at any point. No cloud service is contacted. |
| AC-20 | No per-project configuration file is read or written. |

---

## 7. Definition of done — the "walk away" scenario

The system is done when a user can do all of the following without typing a
command after the first message:

1. Enable Autonomous Sessions in Desktop settings (once, ever).
2. Start a long coding task in a normal Goose session.
3. Close the laptop. Come back the next morning. The task is complete and
   verified, with a full session lineage visible in the UI.
4. Sometime during the night the controller hit 75% context, rolled into
   Worker 02, then Worker 03, declared COMPLETE, ran Verification 01 (FAIL),
   spun up Worker 04, declared COMPLETE again, ran Verification 02 (PASS),
   and stopped.
5. At some point the Desktop was killed by an update; on relaunch, recovery
   reconnected the in-flight run and continued.

If all five points hold end-to-end, the product is shipped.

---

## 8. What we explicitly do **not** build

| Out of scope | Why |
| ------------ | --- |
| **No CLI daemon** | The user launches Desktop, not `goose-autonomous-sessions`. The Desktop process itself owns the lifecycle. |
| **No MCP as primary** | This is a Desktop customization. MCP servers may exist alongside, but the controller does not depend on one. |
| **No cloud orchestration** | Everything runs locally. No remote model calls introduced by this module. |
| **No per-project configuration** | One global enable flag and one threshold. The repository is the source of truth for *task* state; the controller's own state lives in app-data. |
| **No dashboard / token analytics / charts** | V1 is intentionally small. A status panel and a session lineage are enough. |
| **No conversation-history transfer** | Continuity is the handoff, not the transcript. This is a hard constraint, not a limitation. |
| **No new database inside Goose's session store** | V1 uses a single tiny state record in app-data. Goose's internal SQLite is left alone. |
