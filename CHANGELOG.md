# Changelog

All notable changes to `goose-autonomous-sessions` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
