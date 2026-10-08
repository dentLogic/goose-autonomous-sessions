# IMPLEMENTATION — `goose-autonomous-sessions`

> Implementation specification. This is the blueprint engineers use to port the
> portable module at `src/autonomous/*` into Goose Desktop's
> `ui/desktop/src/autonomous/`.

**Module shape:** pure TypeScript, zero hard host dependencies, two injected
adapters (`StateStoreAdapter`, `LoggerAdapter`). Reference adapters ship in
`src/autonomous/stateStore.ts` (Prisma), `src/autonomous/logger.ts` (Prisma),
and `examples/in-memory-adapters.ts`.

---

## 1. Source tree

```text
goose-autonomous-sessions/
├── docs/
│   ├── PRD.md
│   ├── TDD.md
│   └── IMPLEMENTATION.md          ← this file
├── src/autonomous/
│   ├── index.ts                   # barrel export
│   ├── types.ts                   # data model + adapter interfaces
│   ├── constants.ts               # schema version, markers, IPC, limits
│   ├── contextMonitor.ts          # ratio + shouldMarkRolloverPending
│   ├── completionDetector.ts      # exact-line marker detection
│   ├── handoff.ts                  # prompt builder, validator, parser, serializer
│   ├── sessionManager.ts          # createFreshSession, formatSessionName
│   ├── navigation.ts              # navigateToSession (event dispatch)
│   ├── controller.ts              # AutonomousSessionController — the state machine
│   ├── recovery.ts                # recover() decision tree
│   ├── stateStore.ts              # Prisma StateStoreAdapter (reference)
│   └── logger.ts                  # Prisma LoggerAdapter (reference)
├── examples/
│   ├── in-memory-adapters.ts      # drop-in adapters for tests/scripts
│   └── standalone-demo.ts         # runs the full loop without a host
├── patches/                       # integration patches for Goose Desktop
├── install.sh / uninstall.sh      # see §14
└── package.json
```

The same source tree ports verbatim to `ui/desktop/src/autonomous/` in the
Goose Desktop checkout. Only the adapter implementations change.

---

## 2. Controller API

`AutonomousSessionController` is the public surface. It is constructed with
three injected dependencies:

```ts
interface ControllerDeps {
  store: StateStoreAdapter;
  logger: LoggerAdapter;
  generateHandoffResponse: (input: { sessionId; objective; prompt }) => Promise<string | null>;
  sendPrompt: (input: { sessionId; prompt; origin: 'continuation' | 'verification' }) => Promise<void>;
}
```

| Method | Spec | Semantics |
| ------ | ---- | --------- |
| `startRun({ sessionId, objective, settings })` | §4.1 | Refuses if an active run already exists. Creates a fresh `AutonomousRun` with `phase='working'`, `workerGeneration=1`. Records the initial user session as a `worker` lineage row. |
| `getState()` | §4.2 | Returns the current `AutonomousRun` (or null). Pure read. |
| `onContextUsage(sessionId, used, limit)` | §3 | Stores usage. If `sessionId !== currentSessionId`, no-op. Sets `rolloverPending` exactly once on the first threshold crossing. **Does not create a session.** |
| `onTurnFinished(sessionId, lastAssistantText, turn)` | §4, §6 | The single entry point for transitions. Serialized (§13). Applies the priority order in §5. |
| `stopRun()` | §4.3 | Sets `status='stopped'`, `phase='stopped'`. Does not delete sessions, handoffs, or logs. |
| `clearAll()` | §4.4 | Wipes the run record and its session lineage. Used by the UI "Reset" button only. |
| `recover(controller)` *(free function)* | §7 of TDD | Called once on host startup. Idempotent. |

---

## 3. Context monitoring semantics

```ts
// contextMonitor.ts
contextRatio(used, limit): number         // clamped to [0,1]
shouldMarkRolloverPending(used, limit, threshold): boolean
pct(used, limit): number                   // 0..100
```

- The threshold is compared with **`>=`**. Exactly 75% trips the flag; 74.9% does not.
- `onContextUsage` only flips `rolloverPending` the first time it crosses. It does
  not un-set it; only a successful rollover or `Stop` clears it.
- `onContextUsage` **never** creates a session. Mid-turn interruption is forbidden.

---

## 4. Turn-finished priority order

`onTurnFinished` is the single serialized entry point for transitions. The
priority order is **fixed**:

| Priority | Condition | Action |
| -------- | --------- | ------ |
| 1 | `phase==='verifying'` and verifier produced a marker | PASS → `handleVerificationPass`; FAIL → `handleVerificationFail`; no marker → `phase='error'`. |
| 2 | Worker emitted `AUTONOMOUS_STATUS: COMPLETE` | `handleWorkerComplete` — overrides any pending rollover. |
| 3 | `rolloverPending === true` | `performRollover`. |
| 4 | otherwise | log "turn finished — continuing"; persist; stay in `working`. |

Worker completion **takes precedence** over a pending rollover: if the worker
declared done at 80% context, we verify; we do not roll over.

---

## 5. Handoff generation + validation

`generateValidatedHandoff(run, sessionId)` runs at most twice:

```text
for attempt in 1..2:
    raw = generateHandoffResponse({sessionId, objective, prompt})
    if raw == null: continue
    parsed = parseHandoffResponse(raw)        // fence-tolerant
    if parsed != null and isValidHandoff(parsed):
        return stampObjective(parsed, run.originalObjective)
    log warn "handoff parse/validation failed (attempt N)"
return null
```

- `buildHandoffPrompt(objective)` produces a strictly-constrained prompt:
  "NO CODE CHANGES, NO TASK CONTINUATION, NO EXPLANATION — ONLY HANDOFF JSON."
- `parseHandoffResponse` strips markdown fences and extracts the outermost JSON object.
- `validateHandoff` enforces field presence, types, per-field length caps, and
  `result ∈ {PASS, FAIL, UNKNOWN}` for each test entry.
- `stampObjective` overwrites `handoff.objective` with the run's immutable
  objective — the model can never rewrite it.
- Two failures → `phase='error'`, `status='error'`, `lastError` set. The
  current session remains available for inspection. **No session is created
  with an invalid handoff.**

---

## 6. Fresh session creation

`createFreshSession` in `sessionManager.ts` calls the host's session-creation
path (ACP `session/new` in Goose Desktop). Two hard rules:

1. **`session/new`, never `session/fork`, never `session/load`.** The whole
   design depends on a clean context boundary.
2. **The previous session id is never supplied as a history source.** The
   new session receives only:
   - the original objective,
   - the serialized handoff,
   - the shared working directory (inherited, not conversation state),
   - the user's existing global provider/model configuration.

Lineage is recorded via `store.recordSession({ sessionId, runId, role,
generation, parentSessionId, name, objective, handoffJson })`. The parent
session is then marked `abandoned` (rollover) or `completed` (worker
finishing).

---

## 7. Continuation prompt

```text
You are continuing an autonomous software-development task.

You are in a COMPLETELY NEW session.
Do NOT assume access to the previous conversation.
Your only sources of truth are: (1) the ORIGINAL OBJECTIVE below,
(2) the HANDOFF below, and (3) the actual repository state you can inspect yourself.

Do NOT stop merely because the handoff says something is complete.
Verify the actual repository state yourself before trusting any claim.

ORIGINAL OBJECTIVE:
<objective>

HANDOFF:
<serialized handoff>

Continue the work now.

When the ENTIRE original objective is genuinely complete, end your response with exactly:
AUTONOMOUS_STATUS: COMPLETE

Otherwise end with exactly:
AUTONOMOUS_STATUS: CONTINUE
```

## 8. Verification prompt

```text
You are an INDEPENDENT verification agent for an autonomous software-development task.

You are in a completely new session. Do NOT trust the previous session's claims.
Inspect the actual repository yourself.

Verify the ORIGINAL OBJECTIVE independently:
- Review the implementation.
- Run appropriate tests.
- Check for incomplete work.
- Check for regressions.
- Check that requirements were actually implemented.

ORIGINAL OBJECTIVE:
<objective>

WORKER HANDOFF (treat as claims, verify against the real repo):
<serialized handoff>

If everything is genuinely complete, end your response with exactly:
AUTONOMOUS_VERIFICATION: PASS

If anything remains incomplete or incorrect, end with exactly:
AUTONOMOUS_VERIFICATION: FAIL
and then list the specific remaining problems.
```

---

## 9. Completion markers — exact-line matching

```ts
// constants.ts
MARKER_WORKER_COMPLETE   = 'AUTONOMOUS_STATUS: COMPLETE'
MARKER_WORKER_CONTINUE   = 'AUTONOMOUS_STATUS: CONTINUE'
MARKER_VERIFY_PASS       = 'AUTONOMOUS_VERIFICATION: PASS'
MARKER_VERIFY_FAIL       = 'AUTONOMOUS_VERIFICATION: FAIL'

REGEX_WORKER_COMPLETE = /^AUTONOMOUS_STATUS:\s*COMPLETE\s*$/m
REGEX_WORKER_CONTINUE = /^AUTONOMOUS_STATUS:\s*CONTINUE\s*$/m
REGEX_VERIFY_PASS     = /^AUTONOMOUS_VERIFICATION:\s*PASS\s*$/m
REGEX_VERIFY_FAIL     = /^AUTONOMOUS_VERIFICATION:\s*FAIL\s*$/m
```

Detection in `completionDetector.ts` uses `RegExp.test`. No fuzzy matching. A
sentence like *"I think we're done."* does **not** count as completion.
A missing or malformed verifier marker puts the run into `error` rather than
guessing PASS or FAIL.

---

## 10. Verification workflow

```text
worker emits AUTONOMOUS_STATUS: COMPLETE
        │
        ▼
generateValidatedHandoff(workerSession)   ← final handoff
        │
        ▼
phase = verifying
verificationAttempt += 1
        │
        ▼
createFreshSession(role='verification', generation=verificationAttempt)
        │
        ▼
sendPrompt(verification prompt)
navigateToSession(verifier session)
        │
        ▼
phase stays verifying; on next turn finished:
        │
   ┌────┴────┐
   ▼         ▼
  PASS       FAIL
   │         │
   ▼         ▼
COMPLETED   build fail-handoff from verifier findings:
            remainingWork = extractFindings(verifierText)
            failures      = extractFindings(verifierText)
            nextAction    = extractNextAction(verifierText) ?? <fallback>
            │
            ▼
            createFreshSession(role='worker', generation=workerGeneration+1)
            sendPrompt(continuation prompt with fail-handoff)
            navigateToSession(new worker)
            phase = working
```

On PASS: `phase='completed'`, `status='completed'`, the verifier session is
marked `completed`, and the **active run** is finished. The global
`enabled` flag stays on — the next user task can start another run.

---

## 11. Anti-loop rule

The verifier **never** spawns another verifier. A verifier that emits
`AUTONOMOUS_VERIFICATION: FAIL` always transitions to a fresh **worker**
session, not to another verifier. `verificationAttempt` increments only on
worker→verifier transitions; the verifier's own findings are the worker's
handoff. There is no code path in the controller where
`role='verification'` produces another `role='verification'`.

---

## 12. Race-condition protection

Two independent mechanisms:

### 12.1 Serialized transitions

Every `onTurnFinished` call runs inside a single promise chain
(`transitionPromise`). Concurrent turn-finish/context events cannot
double-fire a transition:

```ts
private serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = this.transitionPromise.then(fn, fn);
  this.transitionPromise = next.then(() => undefined, () => undefined);
  return next;
}
```

### 12.2 Idempotent recovery via `pendingSessionId`

The rollover transition is staged:

```text
phase = handoff                          → persisted
handoff saved                             → persisted
phase = creating-session                 → persisted
   pendingSessionId = <new id>           ← persisted HERE
   session created                        → persisted
   prompt sent                             → persisted
   navigate                                 → persisted
phase = working                           → persisted (clears pendingSessionId)
```

If the host crashes after `pendingSessionId` is persisted but before the
final `phase='working'` write, recovery (`recovery.ts`) sees
`phase='creating-session'` + non-null `pendingSessionId` and adopts it:
`currentSessionId = pendingSessionId`, `workerGeneration += 1`, `phase='working'`.
No second session is created. No prompt is re-sent (the host already sent it
before the crash; if not, the host re-runs `sendPrompt` — the new session id
already matches what the prompt was sent to).

### 12.3 `transitionId`

Each rollover gets a unique `transitionId` so recovery can detect whether a
specific transition already completed (the id is cleared only after the final
`phase='working'` write).

---

## 13. The final implementation contract

> **A fresh autonomous session may only begin with:**
>
> 1. **Original Objective** — the immutable string set by `startRun`,
>    stamped onto every handoff via `stampObjective`.
> 2. **Valid Handoff** — a `Handoff` object that has passed
>    `isValidHandoff` (all mandatory fields present, types correct, length
>    caps respected, `nextAction` non-empty).
> 3. **Current Repository State** — the shared working directory, which the
>    fresh session inspects itself; never trust handoff claims of completion.

This contract is enforced at every entry point that creates a session:

| Entry point | Objective source | Handoff source | Repo source |
| ----------- | ---------------- | -------------- | ----------- |
| `startRun` | user message | none (first session) | cwd |
| `performRollover` | `run.originalObjective` | `generateValidatedHandoff` (worker) | cwd |
| `handleWorkerComplete` | `run.originalObjective` | `generateValidatedHandoff` (final) | cwd |
| `handleVerificationFail` | `run.originalObjective` | handoff built from verifier findings | cwd |

No other code path may call `createFreshSession`. If any of the three
ingredients is missing or invalid, the controller refuses to create the
session and transitions to `error` instead. This is the invariant that makes
the entire design sound.

---

## 14. Installer and patch strategy

The repo ships `install.sh` and `uninstall.sh` for Linux x64 (Debian/Ubuntu).
The installer:

1. checks OS, locates Goose source, verifies supported commit
   (`GOOSE_COMMIT=<exact commit>` recorded in install metadata);
2. creates a backup;
3. copies `src/autonomous/*` into `ui/desktop/src/autonomous/`;
4. applies small, deterministic integration patches to the eight files in
   §4 of the TDD (one import + one lifecycle call each);
5. runs `pnpm run typecheck`, `pnpm test`, `pnpm build`;
6. packages via Electron Forge into `out/make/deb/x64/*.deb`.

Patches are deliberately small and isolated. No huge textual diffs against
existing Goose files.

---

## 15. Testing strategy

| Layer | Coverage |
| ----- | -------- |
| **Unit** | state transitions, threshold math, handoff parse/validate, marker detection, recovery decision tree, duplicate prevention. |
| **Integration** | session creation, prompt submission, transition, navigation event, persistence round-trip. |
| **Desktop** | actual Electron UI behavior — settings panel, navigation, stop button. |
| **Manual autonomous** | real long-lived tasks with deliberately forced rollover/crash/failure. |

The critical end-to-end test (`tests/integration/critical-scenario.ts`):

```text
threshold very low
  → Worker 1 → auto rollover → Worker 2 → auto rollover → Worker 3
  → COMPLETE → Verification 1 (FAIL) → Worker 4 → COMPLETE
  → Verification 2 (PASS) → STOP.
```

If this works, the architecture works.

Crash tests exercise every transaction boundary in §12.2:
after handoff generation, after handoff persistence, after session creation,
after session-id persistence, after continuation prompt, during verification.
Each must recover correctly on restart.
