# goose-autonomous-sessions

Unlimited context for autonomous AI coding agents — automatic session rollover
via structured state handoffs, with independent verification. Local-only, no cloud.

## Quick start (no Goose required — test in 30 seconds)

```bash
bun examples/standalone-demo.ts
```

Watch the full state machine run end-to-end: context fills → rollover → fresh
worker → completion → independent verification → PASS.

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

## Install into Goose Desktop

### Prerequisites

- **Linux** (the only supported platform)
- **Git**
- A local **Goose Desktop source checkout** at the pinned commit:

```bash
git clone https://github.com/aaif-goose/goose.git
cd goose
git checkout ce0c4900837a51b2ae50ce0df1484c34a1be754e
```

### Install

```bash
./install.sh /path/to/goose
```

This will:
1. Verify Linux + Goose source layout + clean git tree
2. Verify the pinned commit matches
3. Create a backup branch
4. Copy the module (`src/autonomous/`) + adapters into `ui/desktop/src/`
5. Validate + apply all 5 lifecycle patches
6. Print what changed

To also build the customized Desktop:

```bash
./install.sh /path/to/goose --build
```

### Uninstall

```bash
./uninstall.sh /path/to/goose
```

Restores Goose source to its pre-installation state.

## What's in this folder

```
goose-autonomous-sessions/
├── install.sh              # Installer — copies module + applies patches into Goose
├── uninstall.sh            # Uninstaller — restores Goose source
├── package.json             # Package metadata
├── tsconfig.json            # TypeScript config
├── LICENSE                  # MIT
├── src/autonomous/          # The portable controller (14 files, zero hard deps)
│   ├── controller.ts        #   The state machine
│   ├── types.ts             #   All types + adapter interfaces
│   ├── handoff.ts           #   Handoff generation + validation
│   ├── handoff-schema.ts    #   Custom schema support
│   ├── rollover-policy.ts   #   Multi-policy rollover (context/turns/time/cost)
│   ├── webhooks.ts          #   Webhook notifications + HMAC + replay
│   ├── recovery.ts          #   Crash recovery
│   ├── completionDetector.ts#   Exact-line marker matching
│   ├── contextMonitor.ts    #   Context usage tracking
│   ├── sessionManager.ts    #   Fresh session creation
│   ├── navigation.ts        #   Desktop session switching
│   ├── stateStore.ts        #   Prisma reference adapter (lazy-loaded)
│   ├── logger.ts            #   Prisma reference logger (lazy-loaded)
│   ├── constants.ts         #   Markers, IPC channels, defaults
│   └── index.ts             #   Barrel export
├── adapters/                # Goose Desktop host adapters (4 files)
│   ├── electron-state-store.ts  # Atomic JSON persistence in app-data
│   ├── electron-logger.ts       # Batched + rotated JSONL log
│   ├── acp-integration.ts       # ACP session/prompt callers
│   └── electron-ipc-handlers.ts # ipcMain bridge
├── patches/                 # 5 validated lifecycle patches
│   ├── 0001-add-autonomous-event.patch
│   ├── 0002-add-settings-field.patch
│   ├── 0003-wire-useChatSession.patch
│   ├── 0004-wire-navigation.patch
│   ├── 0005-add-electron-ipc.patch
│   ├── PINNED_COMMIT        # ce0c4900837a51b2ae50ce0df1484c34a1be754e
│   ├── SERIES               # Apply order
│   └── validate.sh          # Validates all patches against pinned commit
└── examples/                # Zero-dep demos (test without Goose)
    ├── standalone-demo.ts   # Full pipeline in 30 seconds
    └── in-memory-adapters.ts # In-memory StateStore + Logger
```

## Pinned Goose commit

`ce0c4900837a51b2ae50ce0df1484c34a1be754e`

All 5 patches are validated against this commit. If your Goose source is at a
different commit, the installer will warn you and ask before proceeding.

## License

MIT
