# Contributing to goose-autonomous-sessions

Thanks for your interest in improving `goose-autonomous-sessions`! This project
is a focused, intentionally-small module — the goal is a clean, portable
autonomous-session controller, **not** a second agent framework.

## The one design principle that matters most

> **Conversation continuity is not the mechanism. State continuity is the mechanism.**

Every contribution should reinforce this. If a change introduces a dependency
on previous conversation history for correctness, it does not belong here.

## Getting started

```bash
git clone https://github.com/dentLogic/goose-autonomous-sessions.git
cd goose-autonomous-sessions
bun examples/standalone-demo.ts   # see the state machine run end-to-end
```

The portable module lives in `src/autonomous/`. The demo + in-memory adapters
live in `examples/`. The full spec lives in `docs/`.

## What belongs in a contribution

### ✅ In scope

- Bug fixes in the state machine, handoff validation, or recovery logic
- New `StateStoreAdapter` / `LoggerAdapter` implementations (e.g. for a new host)
- Improvements to the handoff prompt or validation rules
- Better crash-recovery coverage for specific transition stages
- Documentation improvements
- New example scenarios in `examples/`

### ❌ Out of scope (by design — see PRD §40)

- A separate CLI agent
- A background daemon
- An MCP server as the primary mechanism
- A second model runtime
- Cloud orchestration
- Per-project configuration
- A separate database server

## Before opening a PR

1. **Run the demo:** `bun examples/standalone-demo.ts` must complete without errors.
2. **Typecheck:** `bun run typecheck` (or `tsc --noEmit`) must pass.
3. **Lint:** `bun run lint` must pass.
4. **Don't break the adapter contract:** the controller must remain injectable
   with any `StateStoreAdapter` + `LoggerAdapter`. Do not add hard imports of a
   specific persistence layer into `controller.ts`, `recovery.ts`,
   `sessionManager.ts`, or `navigation.ts`.
5. **Don't introduce conversation-history dependencies:** a fresh session must
   always be able to continue from `objective + handoff + repo state` alone.

## Commit message convention

```
<type>: <short description>

<optional body explaining why>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

## Reporting bugs

When filing an issue, include:

- What you expected
- What actually happened
- The relevant log lines (from the event log)
- The persisted `AutonomousRun` state (the raw JSON — see the "inspect raw
  state" button in the control center, or `store.getRun()`)
- Whether you can reproduce it with `examples/standalone-demo.ts`

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
