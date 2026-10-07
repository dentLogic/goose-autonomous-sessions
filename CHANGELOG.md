# Changelog

All notable changes to `goose-autonomous-sessions` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
