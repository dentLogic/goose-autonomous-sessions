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
