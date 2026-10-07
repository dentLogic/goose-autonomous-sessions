<div align="center">

# 🪿 goose-autonomous-sessions

### Unlimited context for autonomous AI coding agents — without copying a single conversation.

[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg?style=flat-square)](LICENSE)
[![Platform: Linux](https://img.shields.io/badge/Platform-Linux-646CFF?style=flat-square&logo=linux&logoColor=white)](#)
[![Made for Goose](https://img.shields.io/badge/Made%20for-Goose%20Desktop-FFB000?style=flat-square)](https://github.com/aaif-goose/goose)
[![Local-first](https://img.shields.io/badge/Architecture-Local%20first-22C55E?style=flat-square)](#-local-first--no-cloud)
[![No cloud](https://img.shields.io/badge/Cloud-None-22C55E?style=flat-square)](#-local-first--no-cloud)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](#)
[![Status: v0.2](https://img.shields.io/badge/Status-v0.2-FFB000?style=flat-square)](#-roadmap)
[![Tests: 46 passing](https://img.shields.io/badge/Tests-46%20passing-22C55E?style=flat-square)](#-test-suite)
[![Patches: 5 validated](https://img.shields.io/badge/Patches-5%20validated-646CFF?style=flat-square)](#-install--uninstall)

</div>

---

> **Start a 12-hour development task. Walk away. Come back to verified, complete work —
> across as many fresh sessions as it took. No babysitting. No lost context.
> No cloud.**

`goose-autonomous-sessions` is a **global autonomous-session controller for Goose Desktop**
that automatically rolls over to a fresh session when context gets full, carries the work
forward through a compact structured handoff, and only stops when an **independent
verification session** confirms the task is genuinely complete.

It runs entirely on **local models through LM Studio** — no API keys, no cloud calls, no
data ever leaves your machine.

---

## 📑 Table of contents

- [🎯 The 30-second pitch](#-the-30-second-pitch)
- [🔥 The problem we solve](#-the-problem-we-solve)
- [💡 The solution: state continuity, not conversation continuity](#-the-solution-state-continuity-not-conversation-continuity)
- [⚙️ How it works](#️-how-it-works)
- [✨ Features](#-features)
- [🚀 Quick start — see it in 30 seconds](#-quick-start--see-it-in-30-seconds)
- [🏆 The 100 % productivity workflow](#-the-100-productivity-workflow)
- [🏗️ Architecture](#️-architecture)
- [📋 The handoff format](#-the-handoff-format)
- [🛡️ Crash recovery](#️-crash-recovery)
- [⚙️ Configuration](#️-configuration)
- [🔌 Integrating with Goose Desktop](#-integrating-with-goose-desktop)
- [📦 Install / Uninstall](#-install--uninstall)
- [❓ FAQ](#-faq)
- [🔒 Local-first & no cloud](#-local-first--no-cloud)
- [🗺️ Roadmap](#️-roadmap)
- [📚 Documentation](#-documentation)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

---

## 🎯 The 30-second pitch

| Without `goose-autonomous-sessions` | With `goose-autonomous-sessions` |
| --- | --- |
| Long tasks die when the context fills up | Tasks run across **unlimited fresh sessions** |
| Manual "start a new chat, paste context" | **Automatic rollover** with a structured handoff |
| The model claims "done" and you hope it's true | An **independent verifier** confirms it before stopping |
| A crash loses everything | State survives in **persistent storage**; recovery is automatic |
| Cloud API bills for every token | **100 % local** via LM Studio — no cloud, no keys |
| Per-project setup | **Global** — works across every repo, zero config |

---

## 🔥 The problem we solve

Every autonomous AI coding agent eventually hits the same wall:

```
context fills up  →  model forgets earlier decisions  →  work degrades
                  →  compaction loses detail          →  tasks stall
                  →  starting fresh loses state        →  you babysit
```

You've been there: you start a big task, the agent works for 40 minutes, context
reaches 90 %, and now it's hallucinating, repeating itself, or just refusing to
continue. You start a new session — but now it doesn't know what was already done.

**The conversation is too long. The state is too important to lose.**

---

## 💡 The solution: state continuity, not conversation continuity

`goose-autonomous-sessions` makes one deliberate design choice that changes everything:

> **The handoff — not the conversation history — is the continuity mechanism.**

When context approaches its limit, the system:

1. Lets the current turn finish (never interrupts)
2. Generates a **compact structured handoff** (what's done, what remains, the exact next action)
3. Creates a **completely fresh session** — no old messages loaded
4. Feeds it `original objective + handoff + repo state`
5. Switches the Desktop UI to the new session automatically
6. Continues working

Repeat as many times as needed. When the worker finally says it's done, a **fresh
independent verification session** inspects the actual repository and either confirms
(`PASS`) or sends the work back (`FAIL`).

```
Original Task
     │
     ▼
Worker 1 ──── context full ──▶ [handoff] ──▶ Worker 2
     │                                            │
     │                                  context full
     │                                            │
     │                                            ▼
     │                                       Worker 3 ──▶ COMPLETE
     │                                                        │
     │                                                        ▼
     │                                              Verification 1
     │                                                  ┌───┴───┐
     │                                                 PASS     FAIL
     │                                                  │        │
     ▼                                                  ▼        ▼
   DONE                                          (stop)     Worker 4 ──▶ …
```

---

## ⚙️ How it works

The controller is a **small, explicit state machine** with zero hard dependencies
on any persistence layer:

```
                 ┌─────────────────────────────────────────┐
                 │            AutonomousSessionController    │
                 │   (the state machine — pure TypeScript)  │
                 └──────────────┬──────────────────────────┘
                                │
            ┌───────────────────┼────────────────────┐
            ▼                   ▼                    ▼
   ┌─────────────────┐  ┌──────────────┐  ┌────────────────┐
   │ ContextMonitor  │  │   Handoff    │  │   Completion   │
   │  (>= threshold) │  │  Generator   │  │   Detector     │
   │                 │  │ (validate +  │  │ (exact markers)│
   │                 │  │  retry once) │  │                │
   └─────────────────┘  └──────────────┘  └────────────────┘
            │                   │                    │
            └───────────┬───────┴────────────────────┘
                        ▼
              ┌──────────────────┐         ┌──────────────────────┐
              │  SessionManager   │         │  Recovery (idempotent│
              │ (fresh ACP session│ ◀────── │  via pendingSessionId)│
              │  — no history)    │         └──────────────────────┘
              └──────────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │     Navigation    │
              │ (auto-switch UI)  │
              └──────────────────┘
```

**Persistence and logging are injected as adapters** — so the *same* controller
class runs unchanged inside Goose Desktop (Electron main-process adapters), a
Next.js app (Prisma/SQLite adapters), or a standalone script (in-memory adapters).

---

## ✨ Features

- 🔄 **Automatic context rollover** — detects when context crosses the threshold
  (default 75 %), waits for the turn to finish, then rolls to a fresh session.
- 📋 **Structured handoffs** — machine-readable JSON with validation, not prose
  summaries. Every field has a purpose; the `nextAction` field tells the next
  agent exactly what to do first.
- 🆕 **Genuinely fresh sessions** — never loads old conversation history. Each
  rollover creates a real new ACP session with only `objective + handoff`.
- 🔍 **Independent verification** — a separate verifier session inspects the
  actual repo (not the worker's claims) and emits `PASS` / `FAIL`.
- ♾️ **No arbitrary session limit** — roll over 5 times or 500 times.
- 🛡️ **Crash recovery** — state survives crashes, reboots, and Desktop restarts.
  Recovery never guesses; it uses `pendingSessionId` for idempotent transitions.
- 🏠 **100 % local** — works with LM Studio or any local model provider. No
  cloud calls, no API keys, no telemetry.
- 🌍 **Global, not per-project** — enable once; it works across every repository.
- ⚡ **Race-safe** — serialized transitions prevent double-rollover from
  concurrent context/turn-finish events.
- 🎯 **Exact-marker completion detection** — `AUTONOMOUS_STATUS: COMPLETE` and
  `AUTONOMOUS_VERIFICATION: PASS` are matched by exact-line regex, not fuzzy NLP.
- 🪶 **Small by design** — ~12 TypeScript files, no daemon, no MCP server, no
  second agent runtime. Just a controller and its adapters.

---

## 🚀 Quick start — see it in 30 seconds

No database, no Electron, no build step. Just the portable controller + in-memory
adapters:

```bash
git clone https://github.com/dentLogic/goose-autonomous-sessions.git
cd goose-autonomous-sessions

# Run the standalone demo (works with bun, tsx, or ts-node)
bun examples/standalone-demo.ts
```

You'll watch the full lifecycle play out in your terminal:

```
🤖 goose-autonomous-sessions — standalone demo

Objective: "Build a REST API with auth, tests, and docs."

── turn 1: worker 1, turn 1 (ctx → 30%) ──
  ● run started — objective: "Build a REST API with auth, tests, and docs."
  ● Worker 01 active (session user-session-1)
  → phase: working  |  worker gen: 1  |  verify attempt: 0  |  rollover pending: false

── turn 3: worker 1, turn 3 (crosses 75%) (ctx → 78%) ──
  ● context threshold reached (78%) — rollover pending
  → phase: handoff  |  worker gen: 1  |  rollover pending: true

  ● generating handoff
  ● [Auto] Worker 02 created (session s-...)
  ● continuation prompt sent
  ● navigated to session s-...
  ● [Auto] Worker 02 activated

── turn 5: worker 2, turn 2 (ctx → 25%) ──
  ● worker reported AUTONOMOUS_STATUS: COMPLETE
  ● verification attempt 1 starting
  → phase: verifying  |  worker gen: 2  |  verify attempt: 1

── turn 6: verification (ctx → 15%) ──
  ● AUTONOMOUS_VERIFICATION: PASS — run completed
  → phase: completed

─── demo summary ───
  final status:  completed
  sessions created: 3
    • [Auto] Worker 01          worker       abandoned
    • [Auto] Worker 02          worker       completed
    • [Auto] Verification 01    verification completed
```

**That's the entire pipeline:** rollover → fresh worker → completion → independent
verification → PASS → done. In ~30 seconds, with zero infrastructure.

---

## 🏆 The 100 % productivity workflow

This is how you use `goose-autonomous-sessions` for **real work**, end-to-end:

### 1. Set up once (global)

Enable the feature in Goose Desktop settings:

```
Autonomous Sessions:  ✓ Enable
Rollover threshold:   75 %
```

That's it. No per-project config. No `.goose-autonomous.json` in every repo.

### 2. Start a real task

Open Goose Desktop, point it at your repo, and give it a substantial objective:

```
Implement issue #247: add pagination to the /api/users endpoint,
including tests, migration, and updated docs. Ensure all existing
tests still pass.
```

### 3. Walk away

Goose will:

- Work normally in Worker 01
- When context hits 75 %, finish the current turn, generate a handoff,
  create Worker 02, switch to it, continue
- Repeat for as many sessions as the task needs (no limit)
- When a worker believes it's done, spin up a **fresh verifier** that
  independently checks the repo
- If the verifier says `FAIL`, spin up a new worker with the verifier's
  findings as the handoff — and try again
- Only stop when a verifier emits `AUTONOMOUS_VERIFICATION: PASS`

### 4. Come back to verified work

When you return, the run is either:

- ✅ **`completed`** — an independent verifier confirmed the objective is met
- ⚠️ **`error`** — something went wrong (handoff generation failed, etc.);
  the state is preserved so you can inspect and resume
- ⏸️ **`stopped`** — you (or a crash) stopped it; resume explicitly

You can check the live status in the Desktop UI at any time:

```
Autonomous Sessions
Status: Running
Phase: Independently verifying
Worker generation: 3
Context: 18 %
```

### Why this is "100 % productivity"

| Traditional autonomous agent | With goose-autonomous-sessions |
| --- | --- |
| You monitor for context exhaustion | The system monitors itself |
| You manually start fresh sessions | Fresh sessions are automatic |
| "Done" might not be done | An independent verifier confirms it |
| A crash loses the run | Recovery resumes from the last handoff |
| You re-explain context every time | The handoff carries it forward |
| Cloud tokens cost $$ for long tasks | Local model = $0, unlimited |

**You start the task. Goose finishes it. You review the result.**

---

## 🏗️ Architecture

### The state machine

```
IDLE → WORKING ──context ≥ threshold──▶ [rollover pending]
                                          │ (turn finishes)
                                          ▼
                                    GENERATING_HANDOFF
                                          │
                                          ▼
                                    CREATING_SESSION
                                          │
                                          ▼
                                    CONTINUING → WORKING …
                                          │
                              worker emits COMPLETE
                                          ▼
                                    VERIFYING
                                    ┌───┴───┐
                                   PASS    FAIL
                                    │       │
                                    ▼       ▼
                                 DONE    WORKING (new worker)
```

### Module layout

```
src/autonomous/
├── index.ts              ← barrel export
├── types.ts              ← AutonomousRun, Handoff, StateStoreAdapter, LoggerAdapter
├── constants.ts          ← markers, regexes, defaults
├── contextMonitor.ts     ← shouldMarkRolloverPending (>= threshold)
├── completionDetector.ts ← exact-line marker matching
├── handoff.ts            ← prompt builder, validation, serialization
├── logger.ts             ← Prisma reference LoggerAdapter
├── stateStore.ts         ← Prisma reference StateStoreAdapter
├── sessionManager.ts     ← createFreshSession (never forks history)
├── navigation.ts         ← Desktop session-switch event
├── controller.ts         ← the state machine (zero hard deps)
└── recovery.ts           ← crash-recovery decision tree
```

The **core** (`controller`, `types`, `handoff`, `contextMonitor`,
`completionDetector`, `constants`, `sessionManager`, `navigation`, `recovery`)
has **zero** imports of any database, host runtime, or `@/` alias. Only
`stateStore.ts` and `logger.ts` (the *reference adapter implementations*) import
Prisma — and those are optional. Your host provides its own adapters.

---

## 📋 The handoff format

Every rollover produces a validated, structured handoff — not a free-form summary:

```json
{
  "objective": "<immutable — always the original objective>",
  "currentState": "Auth middleware implemented; routes partially wired.",
  "completedWork": [
    "Added src/auth/middleware.ts",
    "Wrote unit tests for token validation"
  ],
  "remainingWork": [
    "Wire auth middleware into /api/users routes",
    "Add integration tests for protected endpoints"
  ],
  "filesChanged": ["src/auth/middleware.ts", "src/auth/middleware.test.ts"],
  "tests": [
    { "command": "npm test", "result": "PASS", "details": "12/12 tests pass" }
  ],
  "failures": [],
  "decisions": ["Used JWT, not session cookies"],
  "constraints": ["Must work in Node 18+", "No new runtime deps"],
  "nextAction": "Wire auth middleware into src/routes/users.ts, then run the full test suite.",
  "generatedAt": "2025-01-15T10:42:18.000Z"
}
```

The controller validates every field before accepting it. If the handoff is
malformed, generation is retried once; if it still fails, the run enters a
controlled `error` state rather than risking false continuity.

---

## 🛡️ Crash recovery

Crashes can happen at any point. The controller is designed so that **restarting
never creates duplicate sessions** and **never guesses**.

On startup, `recover()` inspects the persisted run:

| Persisted phase | Recovery action |
| --- | --- |
| `working` | Reconnect — the live session is still valid |
| `handoff` | Reset to `working`, re-mark rollover pending |
| `creating-session` + `pendingSessionId` exists | Resume the pending session (idempotent) |
| `creating-session` + no pending id | Reset to `working`, re-attempt rollover |
| `verifying` | Reconnect the verifier session |
| `completed` / `stopped` / `error` | Leave as-is |

The critical invariant: **recovery never depends on the previous conversation
being available.** The handoff — saved before the transition — is the checkpoint.

---

## ⚙️ Configuration

### Global settings (persisted)

| Setting | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Master switch for autonomous sessions |
| `rolloverThreshold` | `0.75` | Context ratio at which rollover is marked pending |

### User controls

- **Enable / Disable** — turn the feature on or off globally
- **Rollover threshold** — adjustable 30 %–95 %
- **Stop** — halts the run safely (current turn finishes; no future rollovers)
- **Status** — live phase, generation, verification attempt, context %
- **Recover** — manually trigger the recovery algorithm

---

## 🔌 Integrating with Goose Desktop

The controller is host-agnostic. To wire it into Goose Desktop you provide four
things:

```ts
import { AutonomousSessionController } from 'goose-autonomous-sessions';
import type { StateStoreAdapter, LoggerAdapter } from 'goose-autonomous-sessions';

// 1. Persistence — Electron main process, writes to app.getPath('userData')
const electronStore: StateStoreAdapter = { /* ... */ };

// 2. Logging — writes to autonomous.log in app data
const electronLogger: LoggerAdapter = { /* ... */ };

const controller = new AutonomousSessionController({
  store: electronStore,
  logger: electronLogger,

  // 3. Handoff generation — sends a prompt into the current worker via ACP
  generateHandoffResponse: async ({ sessionId, objective, prompt }) => {
    return acpPromptSession(sessionId, prompt); // returns raw JSON string
  },

  // 4. Prompt submission — calls ACP session/prompt on a fresh session
  sendPrompt: async ({ sessionId, prompt, origin }) => {
    await acpPromptSession(sessionId, prompt);
  },
});
```

Then add small lifecycle hooks in Goose Desktop's existing files (see
[`patches/README.md`](patches/README.md) for the integration points):

```ts
// useChatSession.ts (illustrative)
autonomousController.onContextUsage(sessionId, used, limit);
// ...
await autonomousController.onTurnFinished(sessionId, lastText, turn);
```

The autonomous logic itself never touches Goose internals — it only calls back
into the strategies you injected.

---

## 📦 Install / Uninstall

### Install into Goose Desktop (v0.2 — fully automated)

```bash
git clone https://github.com/dentLogic/goose-autonomous-sessions.git
cd goose-autonomous-sessions

# Point the installer at your Goose source checkout + build the customized Desktop
./install.sh /path/to/goose --build
```

The v0.2 installer does **everything**:

1. ✅ Verifies Linux + Goose source layout + clean git tree
2. ✅ Verifies the pinned Goose commit matches (`ce0c490083...`)
3. ✅ Creates a backup branch (`goose-autonomous-sessions/<timestamp>`)
4. ✅ Copies `src/autonomous/` + `adapters/` → `ui/desktop/src/`
5. ✅ Auto-generates the controller singleton wired to Electron + ACP adapters
6. ✅ **Validates every patch** before applying (aborts cleanly if any fail)
7. ✅ **Applies all 5 lifecycle patches** in series
8. ✅ Optionally builds the customized Desktop (`--build`)

After it completes, launch Goose Desktop → Settings → enable **Autonomous Sessions** → start a task → walk away.

<details>
<summary><b>What the 5 patches do</b></summary>

| Patch | Goose file | What it adds |
| --- | --- | --- |
| `0001-add-autonomous-event` | `constants/events.ts` | `GOOSE_AUTONOMOUS_SWITCH_SESSION` event |
| `0002-add-settings-field` | `utils/settings.ts` | `AutonomousSettings` (enable + threshold) |
| `0003-wire-useChatSession` | `hooks/useChatSession.ts` | `onContextUsage` + `onTurnFinished` hooks |
| `0004-wire-navigation` | `hooks/useNavigationSessions.ts` | Auto-switch to new sessions |
| `0005-add-electron-ipc` | `main.ts` + `preload.ts` | State/settings IPC bridge |

Each patch is minimal: just an import + a hook call. No Goose logic is rewritten. See [`patches/README.md`](patches/README.md) for the full spec.

</details>

<details>
<summary><b>What if my Goose commit doesn't match the pinned one?</b></summary>

The installer warns you and asks before proceeding:

```
⚠  Goose HEAD (abc1234) does not match the pinned commit (ce0c490).
   The patches were generated against the pinned commit and may not apply.

  Attempt anyway? [y/N]
```

If you say yes, the installer still **validates every patch** (`git apply --check`) before applying anything. If validation fails, it aborts cleanly with zero changes to your Goose source.

To check out the exact pinned commit:
```bash
cd /path/to/goose
git checkout ce0c4900837a51b2ae50ce0df1484c34a1be754e
```

</details>

### Uninstall

```bash
./uninstall.sh /path/to/goose
```

Restores the pre-installation state from the backup branch. Your Goose data, normal sessions, and autonomous state files are all preserved.

### Run the tests

```bash
bun test    # 46 tests across state machine, handoff, completion, recovery
```

### Try the zero-dep demo (no Goose required)

```bash
bun examples/standalone-demo.ts
```

---

## 🧪 Test suite

v0.2 ships with **46 tests** covering the full spec:

| File | Tests | Covers |
| --- | --- | --- |
| `tests/state-machine.test.ts` | 11 | start→working, threshold→pending, rollover, verification PASS/FAIL, duplicate prevention, stop semantics |
| `tests/handoff.test.ts` | 14 | prompt builder, validation (8 cases), JSON parsing (fence-tolerant), serialization, objective stamping |
| `tests/completion-detection.test.ts` | 10 | exact-line marker matching, malformed markers, natural-language rejection |
| `tests/recovery.test.ts` | 11 | the full spec-36 decision tree (9 phases + edge cases) |

```bash
$ bun test
  46 pass
  0 fail
  99 expect() calls
  Ran 46 tests across 4 files. [30.00ms]
```

---

## 🔌 Adapters — the portability seam

v0.2 ships reference adapter implementations for Goose Desktop:

```
adapters/
├── electron-state-store.ts      ← StateStoreAdapter (atomic JSON in userData)
├── electron-logger.ts           ← LoggerAdapter (batched + rotated JSONL)
├── acp-integration.ts           ← acpHandoffGenerator + acpSendPrompt
└── electron-ipc-handlers.ts     ← ipcMain.handle bridge (renderer↔main)
```

The controller itself (`src/autonomous/controller.ts`) has **zero** hard dependencies — it only calls the injected `store`, `logger`, `generateHandoffResponse`, and `sendPrompt`. This means the same controller class runs unchanged inside Goose Desktop, a Next.js app, or a standalone script. See [`adapters/README.md`](adapters/README.md) for the wiring diagram.

---

## ❓ FAQ

<details>
<summary><b>Does this copy the old conversation into the new session?</b></summary>

**No — and that's the point.** The new session starts completely fresh. It
receives only `original objective + structured handoff + the repo state it can
inspect itself`. Conversation history is never the continuity mechanism — the
handoff is.
</details>

<details>
<summary><b>What if the worker says "done" but it's wrong?</b></summary>

That's exactly why independent verification exists. A **fresh** verifier session
receives the objective + the final handoff, then inspects the actual repository
itself. If anything is incomplete, it emits `AUTONOMOUS_VERIFICATION: FAIL` and
its findings become the handoff for a new worker. The run only stops on a real
`PASS`.
</details>

<details>
<summary><b>Can the verifier create another verifier?</b></summary>

**No.** The anti-loop rule (spec §57) forbids `Verify → Verify`. Only
`Worker → Verify` is permitted. If verification fails, it spawns a *worker*, not
another verifier.
</details>

<details>
<summary><b>Is there a session limit?</b></summary>

**No.** Worker 1 → 2 → 3 → … → 100 → … is valid. The run stops only on
`AUTONOMOUS_VERIFICATION: PASS`.
</details>

<details>
<summary><b>Does it interrupt the model mid-response?</b></summary>

**Never.** Crossing the threshold marks rollover *pending*. The current turn
always finishes normally. Only then does the controller generate a handoff and
create the fresh session.
</details>

<details>
<summary><b>What happens if Goose crashes?</b></summary>

The run record, the last handoff, and the session lineage all survive in
persistent storage. On restart, `recover()` inspects the persisted phase and
resumes idempotently — it never creates duplicate sessions, and it never guesses.
</details>

<details>
<summary><b>Do I need a cloud API key?</b></summary>

**No.** The system is designed for local models via LM Studio. The rollover
mechanism itself never sends task information externally. Zero cloud, zero keys,
zero telemetry.
</details>

<details>
<summary><b>Does this break normal Goose usage?</b></summary>

**No.** Autonomous Sessions is an explicit mode. If the global setting is off,
Goose Desktop behaves exactly as before.
</details>

<details>
<summary><b>Why not just use MCP?</b></summary>

MCP gives an agent *tools*, but this system needs to *control* context monitoring,
session creation, session switching, the state machine, Desktop navigation, and
crash recovery. Those are lifecycle concerns that belong inside the Desktop
application itself — not in an MCP extension. See the PRD §16 for the full
rationale.
</details>

---

## 🔒 Local-first & no cloud

| Concern | Status |
| --- | --- |
| Handoffs transmitted externally | ❌ Never |
| Credentials in handoffs | ❌ Never (handoffs summarize work, not terminal output) |
| Cloud AI calls | ❌ None |
| Telemetry / analytics | ❌ None |
| State storage | ✅ Local app-data only |
| Model provider | ✅ LM Studio or any local provider |

The handoff generator summarizes work rather than dumping terminal output, so
secrets never leak into the handoff artifact.

---

## 🗺️ Roadmap

### v0.1 — core module ✅

- ✅ Portable controller (zero hard deps)
- ✅ Structured handoff generation + validation
- ✅ Context rollover state machine
- ✅ Independent verification workflow
- ✅ Crash recovery
- ✅ In-memory + Prisma adapter reference implementations
- ✅ Standalone demo
- ✅ Installer (module copy + backup)

### v0.2 — Goose Desktop integration ✅

- ✅ Pinned Goose commit (`ce0c490083...`)
- ✅ 5 validated lifecycle patches (`patches/`)
- ✅ Automated patch application + Desktop build step in installer
- ✅ Electron main-process adapter (atomic JSON persistence in app-data)
- ✅ ACP integration reference (`acpHandoffGenerator` + `acpSendPrompt`)
- ✅ 46-test suite (state machine, handoff, completion, recovery)

### v0.3+ — quality of life

- ⏳ macOS support
- ⏳ Configurable handoff schema (custom fields)
- ⏳ Verification retry budget (opt-in)
- ⏳ npm package publication
- ⏳ Web dashboard for monitoring long runs

See [open issues](https://github.com/dentLogic/goose-autonomous-sessions/issues)
and [CONTRIBUTING.md](CONTRIBUTING.md) for how to help.

---

## 📚 Documentation

| Doc | What's in it |
| --- | --- |
| [**docs/PRD.md**](docs/PRD.md) | Product requirements, the problem, goals, acceptance criteria |
| [**docs/TDD.md**](docs/TDD.md) | Technical design, architecture, data models, recovery algorithm |
| [**docs/IMPLEMENTATION.md**](docs/IMPLEMENTATION.md) | Implementation spec, controller API, state transitions, the integration contract |
| [**examples/README.md**](examples/README.md) | How to run the demo + write your own adapters |
| [**patches/README.md**](patches/README.md) | Planned Goose Desktop integration points |
| [**CHANGELOG.md**](CHANGELOG.md) | Versioned change history |
| [**CONTRIBUTING.md**](CONTRIBUTING.md) | How to contribute + what's in/out of scope |

---

## 🤝 Contributing

Contributions are welcome — but this project is **intentionally small**. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first, especially the section on what's out
of scope (no CLI daemon, no MCP primary, no cloud, no per-project config).

The one design principle that must not be violated:

> **Conversation continuity is not the mechanism. State continuity is the mechanism.**

---

## 📄 License

[MIT](LICENSE) © 2025 [dentLogic](https://github.com/dentLogic)

---

<div align="center">

**Built for developers who want autonomous agents that actually finish the job.**

[Report a bug](https://github.com/dentLogic/goose-autonomous-sessions/issues) ·
[Request a feature](https://github.com/dentLogic/goose-autonomous-sessions/issues) ·
[Read the docs](docs/)

</div>
