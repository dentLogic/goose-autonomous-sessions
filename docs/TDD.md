# TDD — `goose-autonomous-sessions`

> Technical design between the PRD and the implementation spec.

**Target host:** Goose Desktop (Electron + React, ACP-based).
**Reference module:** `src/autonomous/*` (pure TypeScript, host-agnostic).
**Persistence seam:** injected `StateStoreAdapter` + `LoggerAdapter`.

---

## 1. Technical objective

Build a **global autonomous-session controller inside Goose Desktop** that can:
(1) monitor context usage, (2) detect a rollover condition, (3) wait for the
current turn to finish, (4) produce a compact handoff, (5) create a brand-new
ACP session, (6) inject the original objective + handoff, (7) automatically
navigate Desktop to that session, (8) continue indefinitely, (9) detect worker
completion, (10) launch an independent verification session, (11) continue
working if verification fails, (12) persist enough state to recover after
crashes/restarts.

The implementation modifies Goose Desktop; it does not introduce a second
agent runtime.

---

## 2. Architecture — six components

```text
┌───────────────────────────────────────────────────────┐
│                  Goose Desktop                        │
│                                                       │
│  ┌─────────────────┐                                  │
│  │ useChatSession   │                                  │
│  │ integration      │                                  │
│  └────────┬────────┘                                  │
│           │ turn finished                             │
│           ▼                                           │
│  ┌──────────────────────────────┐                     │
│  │ Autonomous Session Controller│                     │
│  └────────────┬─────────────────┘                     │
│               │                                       │
│       ┌───────┼────────┬──────────┐                   │
│       ▼       ▼        ▼          ▼                   │
│   Context  Handoff   Session    State                 │
│   Monitor  Generator  Manager    Store                 │
│       │       │        │          │                   │
│       └───────┴────────┴──────────┘                   │
│                       │                               │
│                       ▼                               │
│                ACP session/new                        │
│                       │                               │
│                       ▼                               │
│                ACP session/prompt                     │
│                       │                               │
│                       ▼                               │
│                Desktop navigation                    │
└───────────────────────────────────────────────────────┘
```

| Component | Responsibility |
| --------- | -------------- |
| **Controller** | The state machine. Owns `phase`, decides transitions, serializes them through one queue. |
| **Context Monitor** | Subscribes to Goose's usage notifications. Computes ratio, decides `rolloverPending`. Never creates a session. |
| **Handoff Generator** | Builds the constrained handoff prompt, parses + validates the JSON response, retries once on failure. |
| **Session Manager** | Calls the host's session-creation path (`session/new`), records lineage, formats session names. |
| **State Store** | Atomic persistence of the single `AutonomousRun` record, settings, session lineage, and logs. |
| **Logger** | Single funnel for all transitions. No prompts or secrets. |

---

## 3. Adapter interfaces — the portability seam

The controller depends on **two** host-injected interfaces and nothing else.
This is what lets the same module run unchanged inside Goose Desktop, a Next.js
demo, or a standalone script.

```ts
export interface StateStoreAdapter {
  getRun(): Promise<AutonomousRun | null>;
  saveRun(run: AutonomousRun): Promise<void>;
  clearRun(): Promise<void>;
  getSettings(): Promise<AutonomousSettings>;
  saveSettings(settings: AutonomousSettings): Promise<void>;
  recordSession(input: { sessionId; runId; role; generation;
                         parentSessionId?; name; objective; handoffJson? }): Promise<void>;
  updateSessionStatus(sessionId, status): Promise<void>;
  getSessions(runId?): Promise<SessionRecord[]>;
  clearSessions(runId?): Promise<void>;
}

export interface LoggerAdapter {
  info(message: string, runId?: string): Promise<void>;
  warn(message: string, runId?: string): Promise<void>;
  error(message: string, runId?: string): Promise<void>;
}
```

Concrete adapters:

| Host | State adapter | Logger adapter |
| ---- | ------------- | -------------- |
| Goose Desktop | Electron main-process JSON file in app-data | Same file (rotating) |
| Next.js reference | Prisma/SQLite (`src/autonomous/stateStore.ts`) | Prisma/SQLite (`logger.ts`) |
| Standalone | In-memory (`examples/in-memory-adapters.ts`) | In-memory |

---

## 4. Integration points with Goose Desktop

The customization touches these existing Desktop areas with **small, deterministic
edits** — no large textual patches.

| Responsibility | Goose area |
| -------------- | ---------- |
| Chat turn lifecycle | `ui/desktop/src/hooks/useChatSession.ts` |
| Session state | `ui/desktop/src/acp/chatSessionStore.ts` |
| ACP session creation | `ui/desktop/src/acp/sessions.ts` |
| ACP prompt submission | `ui/desktop/src/acp/prompt.ts` |
| Usage/context notifications | `ui/desktop/src/acp/adapter/...` |
| Desktop navigation | `ui/desktop/src/hooks/useNavigationSessions.ts` |
| App events | `ui/desktop/src/constants/events.ts` |
| Global Desktop settings | `ui/desktop/src/utils/settings.ts` |

---

## 5. Core data model — `AutonomousRun`

```ts
type AutonomousRun = {
  schemaVersion: number;            // currently 1
  runId: string;
  status: 'active' | 'completed' | 'stopped' | 'error';
  phase: 'working' | 'handoff' | 'creating-session'
       | 'verifying' | 'completed' | 'stopped' | 'error';
  originalObjective: string;         // immutable after startRun
  currentSessionId: string;
  previousSessionId?: string;
  pendingSessionId?: string;          // idempotent recovery handle
  rolloverPending: boolean;
  contextUsage?: number;
  contextLimit?: number;
  rolloverThreshold: number;          // 0..1, default 0.75
  workerGeneration: number;           // increments each fresh worker
  verificationAttempt: number;         // increments each verifier
  transitionId?: string;               // unique per in-flight rollover
  transitionStage?: 'handoff-saved' | 'session-created'
                  | 'prompt-sent' | 'session-active';
  handoff?: Handoff;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};
```

A single record is authoritative. All transitions are atomic upserts of this record.

---

## 6. Handoff data model

Stored as a structured object first (§4 of the PRD), serialized into a compact
text block for prompt embedding only. `nextAction` is mandatory and non-empty.
Per-field length caps live in `constants.ts` (`HANDOFF_FIELD_MAX`).

---

## 7. State machine — states and transitions

| From | Event | To |
| ---- | ----- | -- |
| (none) | `startRun` with user message | `working` |
| `working` | `contextUsage >= threshold` | `working` + `rolloverPending=true` |
| `working` + pending | turn finished | `handoff` |
| `handoff` | handoff generated + validated | `creating-session` |
| `creating-session` | fresh session created, prompt sent, navigated | `working` |
| `working` | `AUTONOMOUS_STATUS: COMPLETE` (turn finished) | `verifying` |
| `verifying` | `AUTONOMOUS_VERIFICATION: PASS` | `completed` |
| `verifying` | `AUTONOMOUS_VERIFICATION: FAIL` | `handoff` → `working` (new worker) |
| any active | user `Stop` | `stopped` |
| any active | handoff generation fails twice | `error` |

Worker completion has **precedence over rollover**: if a turn finishes that contains
`AUTONOMOUS_STATUS: COMPLETE` while `rolloverPending=true`, the controller runs
verification, not rollover.

---

## 8. Crash recovery algorithm

On Desktop startup, `recover(controller)` runs once:

```text
load global autonomous state
        │
        ▼
state exists?
   ┌────┴────┐
   │         │
  no        yes
   │         │
 nothing   inspect status / phase
```

Decision tree:

| `status` | `phase` | Action |
| -------- | ------- | ------ |
| `completed` | — | Leave; report done. |
| `stopped` | — | Leave; user must resume. |
| `error` | — | Surface `lastError`; do not auto-resume. |
| `active` | `working` | Reconnect; host owns the live session. |
| `active` | `verifying` | Reconnect to verifier. |
| `active` | `handoff` | Reset to `working` + `rolloverPending=true`; re-attempt on next turn. |
| `active` | `creating-session` with `pendingSessionId` | **Idempotent resume**: adopt `pendingSessionId`, advance `workerGeneration`, transition to `working`. |
| `active` | `creating-session` without `pendingSessionId` | Reset to `working` + `rolloverPending=true`. |

The controller **never guesses**. If a transition is ambiguous, recovery exposes
the error rather than silently making a choice.

---

## 9. Persistence

**Location:** Goose Desktop's existing Electron application-data directory —
**not** browser `localStorage`, **not** a new table inside Goose's session
database. The controller is a lifecycle component; its state must survive
renderer reloads and Desktop restarts.

**Atomic writes:** every transition is an atomic upsert of the `AutonomousRun`
record. The transition is broken into named stages
(`handoff-saved` → `session-created` → `prompt-sent` → `session-active`), each
persisted separately, so a crash at any point leaves a recovery-distinguishable
state.

**Schema versioning:** `schemaVersion: 1` is written from day one. Future
versions migrate `v1 → v2 → …` instead of invalidating the user's in-flight run.

---

## 10. Key architectural decision

> **The handoff, not the conversation history, is the continuity mechanism.**

This is the one decision that everything else follows from. It gives us:

```text
Session N
    │
    │ ephemeral conversation
    ▼
Handoff
    │
    │ durable state
    ▼
Session N+1
```

State continuity — not conversation continuity — is what makes unlimited
rollover, independent verification, context control, and crash recovery all
tractable in the same design. The repository is the source of truth for *what
was actually done*; the handoff is the source of truth for *what the next
session needs to know*.
