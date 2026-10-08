# dashboard/

Standalone monitoring dashboard for `goose-autonomous-sessions`.

A companion tool for the "walk away" workflow — start a long-running autonomous
task in Goose Desktop, then monitor it live from any browser (including from
another machine via SSH tunnel).

## What it does

Reads the JSON state files that the Electron adapter writes to Goose's app-data
directory and serves a live dashboard at `http://localhost:7878`:

- **State panel** — phase, worker generation, verification attempt, rollover status, last error
- **Context gauge** — live usage % with threshold marker
- **Handoff viewer** — the current structured handoff (current state, next action, completed/remaining work, files, tests, failures)
- **Session timeline** — worker → verification lineage with status badges
- **Event log** — streaming compact log with info/warn/error levels

Auto-refreshes every 1 second + instant updates via Server-Sent Events (SSE).

## Quick start

```bash
# Goose Desktop must be running with Autonomous Sessions enabled.
# The dashboard reads from Goose's app-data directory.

bun dashboard/server.ts
# → dashboard live at http://localhost:7878
```

## Authentication (v0.5)

For remote/shared deployments, set a dashboard token:

```bash
AUTONOMOUS_DASHBOARD_TOKEN=your-secret bun dashboard/server.ts
```

All requests must then include the token as either:
- A Bearer token: `Authorization: Bearer your-secret`
- A query param: `http://localhost:7878?token=your-secret`

Without the token, requests get `401 Unauthorized`. With no token set, auth is disabled (local dev).

## API endpoints (v0.5)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | GET | HTML dashboard |
| `/api/state` | GET | Full state JSON (run + settings + sessions + logs) |
| `/api/metrics` | GET | Compact metrics for monitoring/alerting (Prometheus-friendly) |
| `/api/export` | GET | Full run data as downloadable JSON (with `Content-Disposition`) |
| `/api/health` | GET | Health check (`{ ok, uptime, dataDir }`) for load balancers |
| `/api/events` | GET | Server-Sent Events stream (pushes `change` events) |

### Metrics example

```bash
$ curl http://localhost:7878/api/metrics
{
  "active": 1,
  "completed": 0,
  "worker_generation": 3,
  "verification_attempt": 1,
  "context_usage_pct": 42,
  "rollover_pending": 0,
  "session_count": 4,
  "session_cost_cents": 35,
  "total_cost_cents": 127,
  "phase": "working",
  ...
}
```

### Export example

```bash
$ curl -O -J http://localhost:7878/api/export
# → downloads goose-autonomous-abc12345-1737123456789.json
```

## Custom data directory

If your Goose data lives somewhere else:

```bash
AUTONOMOUS_DATA_DIR=/path/to/goose/data bun dashboard/server.ts
```

Default: `~/.config/Goose/` (Linux, matches Electron's `app.getPath('userData')`).

## Custom port

```bash
PORT=8080 bun dashboard/server.ts
```

## Remote monitoring (SSH tunnel)

Monitor a long-running task from your laptop while it runs on a server:

```bash
# On your laptop:
ssh -L 7878:localhost:7878 user@your-server
# Then open http://localhost:7878 in your laptop's browser
```

The dashboard runs entirely locally — no cloud, no external connections.

## What it reads

| File | Content |
| --- | --- |
| `autonomous-state.json` | The current `AutonomousRun` record |
| `autonomous-settings.json` | Global settings (enable + threshold) |
| `autonomous-sessions.json` | Session lineage (worker → verification chain) |
| `autonomous.log.jsonl` | Compact event log |

These are the same files written by `adapters/electron-state-store.ts` — the
dashboard is a pure reader. It never modifies state.

## Architecture

```
Goose Desktop (Electron main process)
  └─ electron-state-store.ts writes JSON files to app-data
       └─ dashboard/server.ts reads them + serves HTTP + SSE
            └─ Browser renders the live dashboard
```

The dashboard is a single Bun file (`server.ts`) with no external dependencies.
It uses only Node.js built-ins (`http`, `fs`, `path`, `os`, `events`).
