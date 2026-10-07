# patches/

This directory holds the Goose Desktop integration patches — small, targeted
hooks that wire the autonomous controller into Goose's existing lifecycle.

## Status: v0.2 — REAL patches against a pinned Goose commit

These are **real, validated `.patch` files** generated against the pinned Goose
Desktop source. Each patch was produced by fetching the actual file from the
GitHub API at the pinned commit, editing the minimal change, and emitting a
unified diff. All patches were verified with `git apply --check` against the
pinned source.

### Pinned commit

```
ce0c4900837a51b2ae50ce0df1484c34a1be754e
```

- Repo:   [`aaif-goose/goose`](https://github.com/aaif-goose/goose)
- Branch: `main`
- Path:   `ui/desktop/src/`
- Commit message: `fix(anthropic): forward unknown request_params to wire, mirroring openai engine (#12720)`

The pinned SHA is recorded in [`PINNED_COMMIT`](./PINNED_COMMIT).

## Patch set (apply in this order — see [SERIES](./SERIES))

| #     | Patch                                  | Target file(s)                                              | What it adds                                                                                                       |
| ----- | -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0001  | `0001-add-autonomous-event.patch`      | `ui/desktop/src/constants/events.ts`                      | `GOOSE_AUTONOMOUS_SWITCH_SESSION` member of `AppEvents` enum.                                                      |
| 0002  | `0002-add-settings-field.patch`        | `ui/desktop/src/utils/settings.ts`                        | `AutonomousSettings` interface + `Settings.autonomous` field + `defaultSettings.autonomous`.                       |
| 0003  | `0003-wire-useChatSession.patch`       | `ui/desktop/src/hooks/useChatSession.ts`                  | Import of `autonomousController` + `useEffect` reporting context usage + `onTurnFinished` call inside `onFinish`. |
| 0004  | `0004-wire-navigation.patch`           | `ui/desktop/src/hooks/useNavigationSessions.ts`           | `useEffect` listening for `GOOSE_AUTONOMOUS_SWITCH_SESSION` and routing the renderer to the new session.           |
| 0005  | `0005-add-electron-ipc.patch`          | `ui/desktop/src/main.ts` + `ui/desktop/src/preload.ts`    | 5 `ipcMain.handle` registrations + 5 `electronAPI` methods + `'autonomous'` added to `validSettingKeys`.            |

Total: **6 files touched, 134 lines added, 0 removed.** Each patch is minimal —
just the import and the hook call(s). No Goose logic is rewritten.

## How to apply

```bash
# 1. check out the pinned commit in your Goose clone
cd /path/to/goose
git fetch origin ce0c4900837a51b2ae50ce0df1484c34a1be754e
git checkout ce0c4900837a51b2ae50ce0df1484c34a1be754e

# 2. install the autonomous module (src/autonomous/ → ui/desktop/src/autonomous/)
cd /path/to/goose-autonomous-sessions
./install.sh /path/to/goose

# 3. apply the patches in order
cd /path/to/goose
for p in $(cat /path/to/goose-autonomous-sessions/patches/SERIES); do
  git apply /path/to/goose-autonomous-sessions/patches/$p
done

# 4. build the customized Desktop
cd ui/desktop && pnpm install && pnpm run typecheck && pnpm build
```

## Validation

Use [`validate.sh`](./validate.sh) to verify the patches still apply against a
Goose checkout at the pinned commit:

```bash
# against a real Goose checkout
./patches/validate.sh /path/to/goose

# or self-test: clones the pinned commit into a temp dir and runs `git apply --check`
./patches/validate.sh
```

`validate.sh` will:

1. verify `git -C $GOOSE rev-parse HEAD` equals the pinned SHA in `PINNED_COMMIT`,
2. for each patch in `SERIES`, run `git apply --check --verbose` (dry-run) and
   report PASS / FAIL,
3. exit non-zero if any patch fails to apply cleanly.

## Design notes / deviations from the original spec

These were noted during real-source inspection and are reflected in the patches:

- **`ui/desktop/src/utils/settings.ts` exists** at the expected path (the spec's
  "IF IT EXISTS" caveat resolved). It exports `Settings`, `defaultSettings`,
  and `SettingKey`. The patch adds `AutonomousSettings` as a sibling interface
  and `autonomous: AutonomousSettings` as a new field.

- **`useChatSession.ts` has no `onTurnFinished` hook in Goose upstream** — the
  model turn finish is signalled by the `onFinish` callback (line 111). The
  patch inserts `autonomousController.onTurnFinished(...)` at the top of
  `onFinish`, before any existing logic. It pulls the last assistant text from
  `snapshotRef.current.messages` (already maintained by Goose) and never throws
  into Goose's chat path (wrapped in try/catch).

- **`TokenState` already has `contextLimit` and `accumulatedTotalTokens`**
  (`ui/desktop/src/types/chat.ts`). The patch's `useEffect` reports
  `accumulatedTotalTokens` as `used` and `contextLimit` as `limit` to
  `autonomousController.onContextUsage`.

- **`acpNewSession` (sessions.ts) and `acpPromptSession` (prompt.ts) are NOT
  patched directly.** The controller calls them indirectly via the injected
  `sendPrompt` / `generateHandoffResponse` strategies
  (see `src/autonomous/controller.ts` `ControllerDeps`). The host's adapter
  implementation (renderer-side, installed by `install.sh` step 6 as
  `ui/desktop/src/autonomous/stateStore.ts` and friends) calls these ACP
  functions directly. No patch needed on `sessions.ts` or `prompt.ts`.

- **`ui/desktop/src/preload.ts` uses an inline `ElectronAPI` type**, not a
  separate type file. The patch extends both the type and the `electronAPI`
  object with 5 new methods that delegate to the new `autonomous:*` IPC channels.

- **`main.ts` validates setting keys at runtime** via a `validSettingKeys`
  `Set<string>`. The patch adds `'autonomous'` to that set so the existing
  `set-setting` IPC accepts the new field. The dedicated `autonomous:get-state`
  / `set-state` / `clear-state` / `get-settings` / `set-settings` handlers
  read/write `autonomous-state.json` and `autonomous-settings.json` in the
  Electron `userData` directory (mirrors the existing `SETTINGS_FILE` pattern).

## Out of scope for v0.2 patches

- Building the customized `.deb` (handled by `install.sh` step 7 in a future v0.3).
- The renderer-side `StateStoreAdapter` + `LoggerAdapter` implementations that
  call the new IPC bridge — these are part of the autonomous module
  (`src/autonomous/stateStore.ts` in this repo is Prisma-backed; a Goose
  Desktop-specific adapter will be added in v0.3).
- The settings-panel UI for toggling `Settings.autonomous.enabled` — this is
  plain React work in `ui/desktop/src/settings/` and does not need a patch.
