# examples

Runnable examples that show how to wire the portable `goose-autonomous-sessions`
controller into different hosts.

## standalone-demo.ts

The fastest way to see the state machine in action. **Zero external deps** —
no database, no Electron, no Next.js. Just the portable controller + in-memory
adapters + a mock handoff generator.

```bash
bun examples/standalone-demo.ts
# or: npx tsx examples/standalone-demo.ts
```

You will watch the full lifecycle:

1. Run starts
2. Context grows across turns
3. Context crosses 75 % → rollover **pending** (current turn keeps running)
4. Turn finishes → handoff generated → **fresh Worker 02** created
5. Worker 02 continues → reports `AUTONOMOUS_STATUS: COMPLETE`
6. **Fresh verification session** created
7. Verifier returns `AUTONOMOUS_VERIFICATION: PASS`
8. Run completes

### in-memory-adapters.ts

Drop-in `StateStoreAdapter` + `LoggerAdapter` implementations backed by plain
in-memory Maps. Use these as a reference for writing your own adapters (e.g.
an Electron main-process adapter that persists to `app.getPath('userData')`).

## Writing your own adapter

The controller accepts any object that satisfies the adapter interfaces:

```ts
import { AutonomousSessionController } from 'goose-autonomous-sessions';
import type { StateStoreAdapter, LoggerAdapter } from 'goose-autonomous-sessions';

const myStore: StateStoreAdapter = {
  async getRun() { /* read from your persistence layer */ },
  async saveRun(run) { /* write atomically */ },
  // ... (see src/autonomous/types.ts for the full interface)
};

const myLogger: LoggerAdapter = {
  async info(msg, runId) { /* log it your way */ },
  async warn(msg, runId) { /* ... */ },
  async error(msg, runId) { /* ... */ },
};

const controller = new AutonomousSessionController({
  store: myStore,
  logger: myLogger,
  generateHandoffResponse: async ({ sessionId, objective, prompt }) => {
    // call your LLM / ACP session here; return raw JSON string
  },
  sendPrompt: async ({ sessionId, prompt, origin }) => {
    // call ACP session/prompt (or your session API) here
  },
});
```

That's the entire integration surface. The state machine, handoff validation,
completion detection, crash recovery, and verification workflow are all handled
by the controller.
