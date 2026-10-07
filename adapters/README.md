# adapters/

Host-specific reference implementations of the `StateStoreAdapter`,
`LoggerAdapter`, and the two ACP-backed strategies the controller needs.

These are the **bridge between the portable controller and Goose Desktop's
real runtime** (Electron main process + ACP client).

## Files

| File | Purpose |
| --- | --- |
| `electron-state-store.ts` | `StateStoreAdapter` backed by JSON files in `app.getPath('userData')`. Atomic writes (tmp → fsync → rename). |
| `electron-logger.ts` | `LoggerAdapter` backed by `autonomous.log.jsonl` in app-data. Batched + rotated. |
| `acp-integration.ts` | The two ACP-backed strategies: `acpHandoffGenerator` (send a prompt into the current worker + collect the JSON response) and `acpSendPrompt` (call `acpPromptSession` on a fresh session). |
| `electron-ipc-handlers.ts` | Electron `ipcMain.handle` registrations that expose state/settings/logs/sessions to the renderer. Called by patch 0005 in `main.ts`. |

## How they fit together

```
Renderer (React)                         Main process (Electron)
┌──────────────────────┐                 ┌──────────────────────────────┐
│ useChatSession.ts    │                 │ main.ts                       │
│  (patch 0003)        │                 │  registerAutonomousIpc() ←─── │  patch 0005
│   onContextUsage()   │   IPC           │  ↓                            │
│   onTurnFinished()   │ ←─────────────→ │  electronStateStore           │
└──────────┬───────────┘                 │  electronLogger               │
           │                              │  ↓                            │
           │ autonomousController         │  AutonomousSessionController  │
           │ (singleton)                  │  ↓                            │
           │                              │  acpHandoffGenerator          │
           │                              │  acpSendPrompt                │
           ▼                              │  ↓                            │
   src/autonomous/* (portable)            │  ACP client (Goose's own)     │
                                           └──────────────────────────────┘
```

## Wiring (renderer side)

```ts
// ui/desktop/src/autonomous/index.ts (created by install.sh)
import { AutonomousSessionController } from './controller';
import { electronStateStore } from '../adapters/electron-state-store';
import { electronLogger } from '../adapters/electron-logger';
import { acpHandoffGenerator, acpSendPrompt } from '../adapters/acp-integration';

export const autonomousController = new AutonomousSessionController({
  store: electronStateStore,
  logger: electronLogger,
  generateHandoffResponse: acpHandoffGenerator,
  sendPrompt: acpSendPrompt,
});

export { autonomousController as default };
```

## Wiring (main process side)

```ts
// ui/desktop/src/main.ts (patched by 0005)
import { registerAutonomousIpc, onAppQuit } from './adapters/electron-ipc-handlers';

app.whenReady().then(() => {
  registerAutonomousIpc();
  // ... existing Goose setup
});

app.on('before-quit', async (e) => {
  e.preventDefault();
  await onAppQuit();
  app.exit(0);
});
```

That's the entire integration surface. The state machine, handoff validation,
completion detection, crash recovery, and verification workflow all live in
the portable `src/autonomous/` module.
