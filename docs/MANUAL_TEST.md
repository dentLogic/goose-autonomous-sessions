# Manual Integration Test — Real Goose + LM Studio

This document describes the manual test procedure for verifying
`goose-autonomous-sessions` against a real Goose Desktop + LM Studio setup.

**Status: NOT YET EXECUTED.** This is the test plan. The automated test suite
(191 tests) covers the portable controller logic; this document covers the
end-to-end integration with real Goose + a real local model.

## Prerequisites

1. **Linux** (the only supported platform)
2. **Goose Desktop source** checked out at the pinned commit:
   ```bash
   git clone https://github.com/aaif-goose/goose.git
   cd goose
   git checkout ce0c4900837a51b2ae50ce0df1484c34a1be754e
   ```
3. **LM Studio** running with a model loaded (e.g. `qwen2.5-coder-7b`)
4. **Goose configured to use LM Studio** as the provider
5. **pnpm** installed (`npm i -g pnpm`)
6. **Rust/Cargo** (for Goose's native crates)

## Test 1: Install + build

```bash
cd /path/to/goose-autonomous-sessions
./install.sh /path/to/goose --build
```

**Expected:**
- Installer validates Linux, Goose layout, clean git tree, pinned commit
- Backup branch created
- Module + adapters copied (15 + 4 files)
- All 5 patches applied
- `pnpm install && pnpm build` completes
- Goose Desktop launches

**Pass criteria:** Goose Desktop starts without errors.

## Test 2: Enable Autonomous Sessions

1. Launch Goose Desktop
2. Open Settings
3. Verify "Autonomous Sessions" toggle exists
4. Enable it
5. Set rollover threshold to 75% (default)

**Pass criteria:** Settings persist across restart.

## Test 3: Short task with forced rollover

1. Set rollover threshold to **1%** (forces immediate rollover)
2. Start a task: "Add a `hello()` function to `src/index.ts`"
3. Observe the run

**Expected sequence:**
- Worker 01 starts
- Context crosses 1% → rollover pending
- Turn finishes → handoff generated
- Worker 02 created (fresh session)
- Worker 02 continues
- Worker 02 reports `AUTONOMOUS_STATUS: COMPLETE`
- Verification 01 created
- Verifier inspects the repo
- Verifier returns `AUTONOMOUS_VERIFICATION: PASS`
- Run completes

**Pass criteria:**
- At least 1 rollover occurs
- A fresh worker session is created
- Verification runs
- Run reaches `completed` status

## Test 4: Crash recovery

1. Start a task (threshold 75%)
2. While the run is active, kill Goose Desktop (`kill -9`)
3. Restart Goose Desktop

**Expected:**
- Goose recovers the run from persisted state
- The run resumes from the phase it was in (or `working` if mid-rollover)
- No duplicate sessions are created

**Pass criteria:** Run resumes without data loss.

## Test 5: Stop + resume

1. Start a task
2. Click "Stop" in the UI
3. Verify the run enters `stopped` status
4. Click "Resume"
5. Verify the run returns to `active`

**Pass criteria:** Stop preserves state; resume restores it.

## Test 6: Verification FAIL → remediation

1. Set a task that's deliberately incomplete: "Add hello() AND goodbye() functions"
2. Wait for the worker to report COMPLETE (it may only do `hello()`)
3. Observe the verifier

**Expected:**
- Verifier inspects the repo
- Verifier finds `goodbye()` missing
- Verifier returns `AUTONOMOUS_VERIFICATION: FAIL`
- A new worker session is created with the verifier's findings as the handoff
- The new worker implements `goodbye()`
- Verification passes on the second attempt

**Pass criteria:** FAIL→remediation loop works end-to-end.

## Test 7: Dashboard monitoring

1. Start a long task
2. In a separate terminal: `bun dashboard/server.ts`
3. Open `http://localhost:7878` in a browser

**Expected:**
- Dashboard shows live state (phase, context %, worker generation)
- Handoff viewer populates when a rollover occurs
- Session timeline shows the worker→verifier lineage
- Event log streams in real time

**Pass criteria:** Dashboard reflects the live run state within 1 second.

## Test 8: CLI inspection

1. While a run is active: `bun cli/goose-autonomous.ts state`
2. `bun cli/goose-autonomous.ts logs --limit 20`
3. `bun cli/goose-autonomous.ts sessions`

**Pass criteria:** CLI output matches the dashboard state.

## Test 9: Webhook delivery (if webhooks configured)

1. Configure a webhook: `webhooks: ['http://localhost:9999/hook']`
2. Start a local HTTP server on port 9999
3. Start a task
4. Observe webhook deliveries

**Expected:**
- `run.started` webhook fires
- `rollover.completed` fires on each rollover
- `run.completed` fires on completion

**Pass criteria:** Webhooks arrive with valid HMAC signatures (if secret set).

## Test 10: Uninstall

1. Run `./uninstall.sh /path/to/goose`
2. Verify Goose source is restored to the pre-installation state
3. Verify `autonomous/` and `adapters/` dirs are removed
4. Launch Goose Desktop — verify it works normally

**Pass criteria:** Goose source is clean; normal Goose usage is unaffected.

---

## Results template

For each test, record:

| Test | Result | Notes |
|------|--------|-------|
| 1. Install + build | ⏳ Not run | |
| 2. Enable Autonomous | ⏳ Not run | |
| 3. Forced rollover | ⏳ Not run | |
| 4. Crash recovery | ⏳ Not run | |
| 5. Stop + resume | ⏳ Not run | |
| 6. FAIL → remediation | ⏳ Not run | |
| 7. Dashboard | ⏳ Not run | |
| 8. CLI | ⏳ Not run | |
| 9. Webhooks | ⏳ Not run | |
| 10. Uninstall | ✅ Verified | Clean state confirmed in audit |

When a test is run, update the result to ✅ Pass / ❌ Fail with notes.
