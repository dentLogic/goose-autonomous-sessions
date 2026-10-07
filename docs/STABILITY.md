# API Stability — v1.0

This document defines the **public API surface** that is frozen as of v1.0.
Changes to these exports follow Semantic Versioning:

- **Patch** (1.0.x): bug fixes, no API changes
- **Minor** (1.x.0): additive changes only (new exports, new optional fields)
- **Major** (2.0.0): breaking changes to any frozen export

## Frozen exports

All exports from `src/autonomous/index.ts` are part of the public API. The
following are explicitly marked **@stable** (frozen) or **@experimental**
(may change in a minor release).

### Core types (`@stable`)

| Export | Since | Stability |
|--------|-------|-----------|
| `AutonomousRun` | v0.1 | @stable |
| `AutonomousSettings` | v0.1 | @stable |
| `Handoff` | v0.1 | @stable |
| `HandoffTest` | v0.1 | @stable |
| `AutonomousPhase` | v0.1 | @stable |
| `AutonomousRunStatus` | v0.1 | @stable |
| `SessionRole` | v0.1 | @stable |
| `TransitionStage` | v0.1 | @stable |
| `AgentTurn` | v0.1 | @stable (added `costCents` in v0.5 — optional, backward compat) |
| `StateStoreAdapter` | v0.2 | @stable |
| `LoggerAdapter` | v0.2 | @stable |
| `SessionRecord` | v0.2 | @stable |
| `LogEntry` | v0.1 | @stable |
| `RolloverPolicy` | v0.4 | @stable (added `maxCostCentsPerSession` in v0.5 — optional) |
| `RolloverReason` | v0.4 | @stable (added `'cost'` in v0.5 — additive) |
| `WebhookEvent` | v0.6 | @stable |
| `WebhookPayload` | v0.6 | @stable |
| `WebhookConfig` | v0.7 | @stable (added `retry` in v0.8 — optional) |
| `WebhookRetryPolicy` | v0.8 | @stable (added `jitter` in v0.9 — optional) |
| `WebhookDeliveryRecord` | v0.7 | @stable (added `payload`/`config` in v0.9 — optional) |
| `HandoffField` | v0.3 | @stable |
| `HandoffSchema` | v0.3 | @stable |
| `HandoffFieldType` | v0.3 | @stable |

### Controller (`@stable`)

| Export | Since | Stability |
|--------|-------|-----------|
| `AutonomousSessionController` | v0.1 | @stable |
| `ControllerDeps` | v0.2 | @stable (all fields optional except store/logger/generateHandoffResponse/sendPrompt) |
| `HandoffGenerator` | v0.1 | @stable |
| `ContinuationPromptSender` | v0.1 | @stable |

### Controller methods (`@stable`)

| Method | Since | Stability |
|--------|-------|-----------|
| `startRun(input)` | v0.1 | @stable |
| `onContextUsage(sessionId, used, limit)` | v0.1 | @stable |
| `onTurnFinished(sessionId, text, turn)` | v0.1 | @stable |
| `stopRun()` | v0.1 | @stable |
| `resumeRun()` | v0.5 | @stable |
| `clearAll()` | v0.1 | @stable |
| `getState()` | v0.1 | @stable |

### Functions (`@stable`)

| Export | Since | Stability |
|--------|-------|-----------|
| `recover(controller)` | v0.1 | @stable |
| `createFreshSession(store, input)` | v0.2 | @stable |
| `formatSessionName(role, gen)` | v0.2 | @stable |
| `evaluateRollover(policy, input)` | v0.4 | @stable |
| `resolvePolicy(policy, threshold)` | v0.4 | @stable |
| `verificationBudgetExceeded(attempt, max)` | v0.4 | @stable |
| `contextRatio(used, limit)` | v0.1 | @stable |
| `shouldMarkRolloverPending(used, limit, threshold)` | v0.1 | @stable |
| `detectWorkerStatus(text)` | v0.1 | @stable |
| `detectVerificationStatus(text)` | v0.1 | @stable |
| `buildHandoffPrompt(objective)` | v0.1 | @stable |
| `validateHandoff(handoff)` | v0.1 | @stable |
| `isValidHandoff(handoff)` | v0.1 | @stable |
| `parseHandoffResponse(raw)` | v0.1 | @stable |
| `serializeHandoff(handoff)` | v0.1 | @stable |
| `stampObjective(handoff, objective)` | v0.1 | @stable |
| `defaultHandoffSchema()` | v0.3 | @stable |
| `createHandoffSchema(base, ext)` | v0.3 | @stable |
| `buildHandoffPromptFromSchema(obj, schema)` | v0.3 | @stable |
| `validateHandoffAgainstSchema(h, schema)` | v0.3 | @stable |
| `serializeHandoffWithSchema(h, schema)` | v0.3 | @stable |
| `parseHandoffResponseWithSchema(raw, schema)` | v0.3 | @stable |
| `coerceToHandoff(parsed, objective)` | v0.3 | @stable |
| `createWebhookNotifier(webhooks, logger)` | v0.6 | @stable |
| `signPayload(secret, body)` | v0.7 | @stable |
| `verifySignature(secret, body, sig)` | v0.7 | @stable |
| `normalizeWebhooks(webhooks)` | v0.7 | @stable |
| `getDeliveryLog(limit, runId?)` | v0.7 | @stable |
| `clearDeliveryLog()` | v0.7 | @stable |
| `replayFailedDeliveries(logger, runId?)` | v0.9 | @stable |
| `getReplayableDeliveries(runId?)` | v0.9 | @stable |
| `buildRunSnapshot(run)` | v0.6 | @stable |

### Constants (`@stable`)

| Export | Since | Stability |
|--------|-------|-----------|
| `AUTONOMOUS_SCHEMA_VERSION` | v0.1 | @stable |
| `DEFAULT_ROLLOVER_THRESHOLD` | v0.1 | @stable |
| `DEFAULT_CONTEXT_LIMIT` | v0.1 | @stable |
| `MAX_LOG_ROWS` | v0.1 | @stable |
| `MARKER_WORKER_COMPLETE` | v0.1 | @stable |
| `MARKER_WORKER_CONTINUE` | v0.1 | @stable |
| `MARKER_VERIFY_PASS` | v0.1 | @stable |
| `MARKER_VERIFY_FAIL` | v0.1 | @stable |
| `NAV_EVENT_SWITCH_SESSION` | v0.1 | @stable |
| `IPC` | v0.2 | @stable |
| `DEFAULT_SETTINGS` | v0.1 | @stable |

### Experimental (`@experimental`)

These exports are NOT frozen and may change in a minor release:

| Export | Since | Notes |
|--------|-------|-------|
| `prismaStateStore` | v0.2 | Reference impl; hosts should inject their own adapter |
| `prismaLogger` | v0.2 | Reference impl; hosts should inject their own adapter |
| `log` | v0.1 | Convenience logger; prefer injecting your own |

## Backward compatibility guarantees

1. **All optional fields remain optional.** New fields added in minor releases
   are always optional with sensible defaults.
2. **No function signature changes.** Existing parameters keep their positions;
   new parameters are appended with default values.
3. **Type narrowing only.** A `string` won't become `string & SomethingElse`
   in a minor release.
4. **Marker regexes are frozen.** The exact-line matching patterns for
   `AUTONOMOUS_STATUS: COMPLETE` etc. will not change.

## Deprecation policy

When an export is deprecated, it remains for at least one major release cycle
with a `@deprecated` JSDoc tag and a migration path in the changelog.
