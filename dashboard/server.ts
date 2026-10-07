// dashboard/server.ts
//
// Standalone monitoring dashboard for goose-autonomous-sessions.
//
// Reads the JSON state files that the Electron adapter writes to app-data
// (autonomous-state.json, autonomous-settings.json, autonomous-sessions.json,
// autonomous.log.jsonl) and serves a live dashboard at http://localhost:7878.
//
// This is NOT a replacement for Goose Desktop's built-in UI. It's a companion
// tool for monitoring long-running autonomous tasks from any browser —
// including from another machine via SSH tunnel.
//
// Usage:
//   bun dashboard/server.ts                          # reads from ~/.config/Goose
//   AUTONOMOUS_DATA_DIR=/path bun dashboard/server.ts  # custom path
//   PORT=8080 bun dashboard/server.ts                # custom port
//
import { readFileSync, existsSync, watchFile, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { getDeliveryLog, clearDeliveryLog } from '../src/autonomous/webhooks';

// ─── config ───────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.AUTONOMOUS_DATA_DIR ?? defaultDataDir();
const PORT = Number(process.env.PORT ?? 7878);
const AUTH_TOKEN = process.env.AUTONOMOUS_DASHBOARD_TOKEN ?? ''; // empty = no auth

function defaultDataDir(): string {
  const home = os.homedir();
  // Goose Desktop on Linux writes to ~/.config/Goose/
  // (mirrors Electron's app.getPath('userData'))
  return path.join(home, '.config', 'Goose');
}

const FILES = {
  run: path.join(DATA_DIR, 'autonomous-state.json'),
  settings: path.join(DATA_DIR, 'autonomous-settings.json'),
  sessions: path.join(DATA_DIR, 'autonomous-sessions.json'),
  logs: path.join(DATA_DIR, 'autonomous.log.jsonl'),
};

// ─── state reader ──────────────────────────────────────────────────────────────

interface RunState {
  runId?: string;
  status?: string;
  phase?: string;
  originalObjective?: string;
  currentSessionId?: string;
  workerGeneration?: number;
  verificationAttempt?: number;
  contextUsage?: number;
  contextLimit?: number;
  rolloverThreshold?: number;
  rolloverPending?: boolean;
  handoff?: unknown;
  lastError?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface SettingsState {
  enabled?: boolean;
  rolloverThreshold?: number;
}

interface SessionRecord {
  sessionId: string;
  name: string;
  role: string;
  generation: number;
  status: string;
  parentSessionId?: string;
  createdAt: string;
  updatedAt: string;
  handoffJson?: string;
}

interface LogRow {
  id: string;
  ts: string;
  level: string;
  message: string;
  runId?: string;
}

function readJsonSafe<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function readLogs(): LogRow[] {
  if (!existsSync(FILES.logs)) return [];
  try {
    const raw = readFileSync(FILES.logs, 'utf8');
    // Support both JSONL and the { logs: [...] } format the Electron adapter writes
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      const obj = JSON.parse(trimmed);
      return Array.isArray(obj.logs) ? obj.logs.slice(-200).reverse() : [];
    }
    // JSONL fallback
    return trimmed
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as LogRow)
      .slice(-200)
      .reverse();
  } catch {
    return [];
  }
}

function readAllState() {
  return {
    run: readJsonSafe<RunState | null>(FILES.run, null),
    settings: readJsonSafe<SettingsState>(FILES.settings, { enabled: false, rolloverThreshold: 0.75 }),
    sessions: readJsonSafe<{ sessions: SessionRecord[] }>(FILES.sessions, { sessions: [] }).sessions,
    logs: readLogs(),
    dataDir: DATA_DIR,
  };
}

// ─── change detection ─────────────────────────────────────────────────────────

const changeEmitter = new EventEmitter();
let lastMtimes: Record<string, number> = {};

function checkForChanges(): void {
  let changed = false;
  for (const key of Object.keys(FILES)) {
    const file = (FILES as Record<string, string>)[key];
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (lastMtimes[key] !== mtime) {
      lastMtimes[key] = mtime;
      changed = true;
    }
  }
  if (changed) {
    changeEmitter.emit('change');
  }
}

// poll for changes every 1s (watchFile can miss rapid back-to-back writes)
setInterval(checkForChanges, 1000);

// ─── HTML dashboard ───────────────────────────────────────────────────────────

function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Goose Autonomous Sessions — Monitor</title>
<style>
  :root { --bg: #0a0a0a; --panel: #18181b; --border: #27272a; --fg: #e4e4e7; --muted: #71717a; --amber: #f59e0b; --emerald: #10b981; --rose: #f43f5e; --sky: #38bdf8; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--fg); font-family: 'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace; font-size: 13px; line-height: 1.5; min-height: 100vh; display: flex; flex-direction: column; }
  header { border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
  header .logo { color: var(--amber); font-weight: 600; font-size: 14px; }
  header .sub { color: var(--muted); font-size: 11px; }
  header .status { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .pill { padding: 3px 10px; border-radius: 4px; font-size: 11px; font-weight: 500; border: 1px solid; }
  .pill.on { background: rgba(245,158,11,.15); color: var(--amber); border-color: rgba(245,158,11,.3); }
  .pill.off { background: rgba(113,113,122,.15); color: var(--muted); border-color: rgba(113,113,122,.3); }
  .pill.active { background: rgba(16,185,129,.15); color: var(--emerald); border-color: rgba(16,185,129,.3); }
  .pill.completed { background: rgba(16,185,129,.15); color: var(--emerald); border-color: rgba(16,185,129,.3); }
  .pill.error { background: rgba(244,63,94,.15); color: var(--rose); border-color: rgba(244,63,94,.3); }
  .pill.stopped { background: rgba(113,113,122,.15); color: var(--muted); border-color: rgba(113,113,122,.3); }
  main { flex: 1; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; padding: 16px 24px; max-width: 1600px; width: 100%; margin: 0 auto; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow: hidden; }
  .card h3 { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
  .card h3 .dot { width: 8px; height: 8px; border-radius: 50%; }
  .metric { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(39,39,42,.5); }
  .metric:last-child { border-bottom: none; }
  .metric .label { color: var(--muted); }
  .metric .value { color: var(--fg); font-weight: 500; }
  .metric .value.amber { color: var(--amber); }
  .metric .value.emerald { color: var(--emerald); }
  .metric .value.rose { color: var(--rose); }
  .objective { color: var(--fg); white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  .gauge { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .gauge svg { flex-shrink: 0; }
  .gauge .pct { font-size: 22px; font-weight: 700; }
  .bar { height: 6px; background: rgba(39,39,42,.8); border-radius: 3px; overflow: hidden; position: relative; margin-top: 8px; }
  .bar .fill { position: absolute; top: 0; left: 0; height: 100%; border-radius: 3px; transition: width .3s; }
  .bar .threshold { position: absolute; top: -2px; width: 2px; height: 10px; background: var(--rose); }
  .timeline { list-style: none; position: relative; padding-left: 16px; border-left: 1px solid var(--border); }
  .timeline li { margin-bottom: 12px; position: relative; }
  .timeline li::before { content: ''; position: absolute; left: -21px; top: 4px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--bg); }
  .timeline li.worker::before { background: var(--amber); }
  .timeline li.verification::before { background: var(--emerald); }
  .timeline li.current::before { box-shadow: 0 0 0 3px rgba(245,158,11,.2); }
  .timeline .name { font-weight: 600; }
  .timeline .meta { color: var(--muted); font-size: 11px; }
  .timeline .badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; margin-left: 6px; text-transform: uppercase; }
  .timeline .badge.completed { background: rgba(16,185,129,.15); color: var(--emerald); }
  .timeline .badge.failed { background: rgba(244,63,94,.15); color: var(--rose); }
  .timeline .badge.abandoned { background: rgba(113,113,122,.15); color: var(--muted); }
  .timeline .badge.active { background: rgba(245,158,11,.15); color: var(--amber); }
  .logs { max-height: 400px; overflow-y: auto; font-size: 11px; }
  .logs .line { display: flex; gap: 8px; padding: 2px 0; border-bottom: 1px solid rgba(39,39,42,.3); }
  .logs .ts { color: var(--muted); flex-shrink: 0; }
  .logs .level { flex-shrink: 0; width: 40px; font-weight: 600; }
  .logs .level.info { color: var(--emerald); }
  .logs .level.warn { color: var(--amber); }
  .logs .level.error { color: var(--rose); }
  .logs .msg { color: var(--fg); word-break: break-word; }
  .empty { color: var(--muted); text-align: center; padding: 24px 8px; font-style: italic; }
  .data-dir { font-size: 10px; color: var(--muted); }
  footer { border-top: 1px solid var(--border); padding: 8px 24px; display: flex; align-items: center; gap: 12px; font-size: 10px; color: var(--muted); }
  footer .live { color: var(--emerald); display: flex; align-items: center; gap: 4px; }
  footer .live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--emerald); animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .handoff-section { margin-bottom: 10px; }
  .handoff-section .label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .handoff-section .content { color: var(--fg); white-space: pre-wrap; word-break: break-word; }
  .handoff-section .content.amber { color: var(--amber); }
  .handoff-list { list-style: none; }
  .handoff-list li { color: var(--fg); padding-left: 12px; position: relative; }
  .handoff-list li::before { content: '›'; position: absolute; left: 0; color: var(--muted); }
</style>
</head>
<body>
<header>
  <span class="logo">🪿 Goose Autonomous Sessions</span>
  <span class="sub">monitor</span>
  <div class="status">
    <span id="auto-pill" class="pill off">Autonomous OFF</span>
    <span id="run-pill" class="pill off">No run</span>
  </div>
</header>
<main>
  <div class="card">
    <h3><span class="dot" style="background:var(--amber)"></span>State</h3>
    <div id="state-metrics"><div class="empty">No active run</div></div>
    <div style="margin-top:16px">
      <h3 style="margin-bottom:8px"><span class="dot" style="background:var(--sky)"></span>Context</h3>
      <div id="context-gauge"><div class="empty">—</div></div>
    </div>
    <div style="margin-top:16px">
      <h3 style="margin-bottom:8px"><span class="dot" style="background:var(--emerald)"></span>Original Objective</h3>
      <div id="objective" class="objective"><span class="empty">—</span></div>
    </div>
  </div>
  <div class="card">
    <h3><span class="dot" style="background:var(--amber)"></span>Current Handoff</h3>
    <div id="handoff"><div class="empty">No handoff yet</div></div>
  </div>
  <div class="card">
    <h3><span class="dot" style="background:var(--sky)"></span>Session Timeline</h3>
    <ul id="timeline" class="timeline"><div class="empty">No sessions</div></ul>
  </div>
  <div class="card" style="grid-column: 1 / -1">
    <h3><span class="dot" style="background:var(--muted)"></span>Event Log <span id="log-count" style="margin-left:auto;font-size:10px;color:var(--muted)"></span></h3>
    <div id="logs" class="logs"><div class="empty">No events</div></div>
  </div>
</main>
<footer>
  <span class="live">live</span>
  <span>auto-refresh: 1s</span>
  <span>data dir: <span id="data-dir" class="data-dir"></span></span>
  <span style="margin-left:auto">goose-autonomous-sessions monitor</span>
</footer>
<script>
const PHASE_LABEL = { working: 'Working', handoff: 'Preparing continuation', 'creating-session': 'Starting fresh session', verifying: 'Independently verifying', completed: 'Completed', stopped: 'Stopped', error: 'Needs attention' };
const PHASE_COLOR = { working: 'amber', handoff: 'amber', 'creating-session': 'amber', verifying: 'emerald', completed: 'emerald', stopped: 'muted', error: 'rose' };

async function refresh() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    render(data);
  } catch (e) {
    console.error('refresh failed', e);
  }
}

function render(data) {
  const { run, settings, sessions, logs, dataDir } = data;
  document.getElementById('data-dir').textContent = dataDir;

  // auto pill
  const autoPill = document.getElementById('auto-pill');
  if (settings?.enabled) { autoPill.textContent = 'Autonomous ON'; autoPill.className = 'pill on'; }
  else { autoPill.textContent = 'Autonomous OFF'; autoPill.className = 'pill off'; }

  // run pill + state
  const runPill = document.getElementById('run-pill');
  const stateEl = document.getElementById('state-metrics');
  if (!run) {
    runPill.textContent = 'No run'; runPill.className = 'pill off';
    stateEl.innerHTML = '<div class="empty">No active run</div>';
    document.getElementById('context-gauge').innerHTML = '<div class="empty">—</div>';
    document.getElementById('objective').innerHTML = '<span class="empty">—</span>';
    document.getElementById('handoff').innerHTML = '<div class="empty">No handoff yet</div>';
  } else {
    runPill.textContent = run.status; runPill.className = 'pill ' + run.status;
    const ctxPct = run.contextLimit ? Math.min(100, Math.round((run.contextUsage / run.contextLimit) * 100)) : 0;
    const thrPct = Math.round((run.rolloverThreshold || 0.75) * 100);
    const phaseColor = PHASE_COLOR[run.phase] || 'muted';
    stateEl.innerHTML = [
      metric('Phase', '<span style="color:var(--' + phaseColor + ')">' + (PHASE_LABEL[run.phase] || run.phase) + '</span>'),
      metric('Worker gen', '#' + run.workerGeneration),
      metric('Verification', run.verificationAttempt ? 'attempt ' + run.verificationAttempt : '—'),
      metric('Rollover', run.rolloverPending ? '<span style="color:var(--amber)">PENDING</span>' : 'idle'),
      run.lastError ? metric('Error', '<span style="color:var(--rose)">' + escapeHtml(run.lastError) + '</span>') : '',
      metric('Updated', run.updatedAt ? new Date(run.updatedAt).toLocaleTimeString() : '—'),
    ].join('');
    // context gauge
    const fillColor = ctxPct >= thrPct ? 'var(--amber)' : 'var(--emerald)';
    document.getElementById('context-gauge').innerHTML = 
      '<div style="font-size:22px;font-weight:700">' + ctxPct + '%</div>' +
      '<div class="bar"><div class="fill" style="width:' + ctxPct + '%;background:' + fillColor + '"></div><div class="threshold" style="left:' + thrPct + '%"></div></div>' +
      '<div style="font-size:10px;color:var(--muted);margin-top:4px">threshold: ' + thrPct + '%</div>';
    // objective
    document.getElementById('objective').textContent = run.originalObjective || '—';
    // handoff
    renderHandoff(run.handoff);
  }

  // timeline
  const tl = document.getElementById('timeline');
  if (!sessions || sessions.length === 0) {
    tl.innerHTML = '<div class="empty">No sessions</div>';
  } else {
    tl.innerHTML = sessions.map(s => {
      const cls = s.role + (s.sessionId === run?.currentSessionId ? ' current' : '');
      return '<li class="' + cls + '">' +
        '<div><span class="name">' + escapeHtml(s.name) + '</span>' +
        '<span class="badge ' + s.status + '">' + s.status + '</span></div>' +
        '<div class="meta">' + new Date(s.createdAt).toLocaleTimeString() + ' · ' + s.sessionId.slice(0, 12) + '</div>' +
      '</li>';
    }).join('');
  }

  // logs
  const logsEl = document.getElementById('logs');
  document.getElementById('log-count').textContent = (logs || []).length + ' entries';
  if (!logs || logs.length === 0) {
    logsEl.innerHTML = '<div class="empty">No events</div>';
  } else {
    logsEl.innerHTML = logs.map(l => 
      '<div class="line"><span class="ts">' + new Date(l.ts).toLocaleTimeString() + '</span>' +
      '<span class="level ' + l.level + '">' + l.level + '</span>' +
      '<span class="msg">' + escapeHtml(l.message) + '</span></div>'
    ).join('');
  }
}

function renderHandoff(h) {
  const el = document.getElementById('handoff');
  if (!h) { el.innerHTML = '<div class="empty">No handoff yet</div>'; return; }
  el.innerHTML = [
    section('Current State', h.currentState),
    section('Exact Next Action', h.nextAction, true),
    listSection('Completed Work', h.completedWork, 'emerald'),
    listSection('Remaining Work', h.remainingWork, 'amber'),
    listSection('Files Changed', h.filesChanged),
    listSection('Failures', h.failures, 'rose'),
    h.tests && h.tests.length ? testsSection(h.tests) : '',
  ].filter(Boolean).join('');
}

function section(label, content, amber) {
  if (!content) return '';
  return '<div class="handoff-section"><div class="label">' + label + '</div><div class="content' + (amber ? ' amber' : '') + '">' + escapeHtml(content) + '</div></div>';
}
function listSection(label, items, color) {
  if (!items || !items.length) return '';
  const colorStyle = color ? ' style="color:var(--' + color + ')"' : '';
  return '<div class="handoff-section"><div class="label">' + label + '</div><ul class="handoff-list"' + colorStyle + '>' + items.map(i => '<li>' + escapeHtml(i) + '</li>').join('') + '</ul></div>';
}
function testsSection(tests) {
  return '<div class="handoff-section"><div class="label">Tests</div>' + tests.map(t => {
    const c = t.result === 'PASS' ? 'emerald' : t.result === 'FAIL' ? 'rose' : 'muted';
    return '<div style="display:flex;gap:6px;align-items:center;margin:2px 0"><span style="color:var(--' + c + ');font-weight:600;width:50px">' + t.result + '</span><span>' + escapeHtml(t.command || '') + '</span>' + (t.details ? '<span style="color:var(--muted)">— ' + escapeHtml(t.details) + '</span>' : '') + '</div>';
  }).join('') + '</div>';
}
function metric(label, value) {
  return '<div class="metric"><span class="label">' + label + '</span><span class="value">' + value + '</span></div>';
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// initial render + polling
refresh();
setInterval(refresh, 1000);

// SSE for instant updates
const sse = new EventSource('/api/events');
sse.addEventListener('change', () => refresh());
</script>
</body>
</html>`;
}

// ─── auth middleware ───────────────────────────────────────────────────────────
//
// If AUTONOMOUS_DASHBOARD_TOKEN is set, all requests must include it as a
// bearer token OR as the ?token= query param. Empty token = no auth (local dev).
function checkAuth(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (!AUTH_TOKEN) return true; // auth disabled
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const queryToken = url.searchParams.get('token');
  if (bearer === AUTH_TOKEN || queryToken === AUTH_TOKEN) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized. Set AUTONOMOUS_DASHBOARD_TOKEN or pass ?token=...' }));
  return false;
}

// ─── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Auth check (skip for the 401 response itself)
  if (!checkAuth(req, res, url)) return;

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboard());
    return;
  }

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readAllState()));
    return;
  }

  // v0.5: metrics endpoint — compact summary for monitoring/alerting
  if (url.pathname === '/api/metrics') {
    const state = readAllState();
    const run = state.run;
    const metrics = {
      // Prometheus-style key/value for easy scraping
      active: run?.status === 'active' ? 1 : 0,
      completed: run?.status === 'completed' ? 1 : 0,
      stopped: run?.status === 'stopped' ? 1 : 0,
      errored: run?.status === 'error' ? 1 : 0,
      worker_generation: run?.workerGeneration ?? 0,
      verification_attempt: run?.verificationAttempt ?? 0,
      context_usage_pct: run?.contextLimit
        ? Math.round(((run.contextUsage ?? 0) / run.contextLimit) * 100)
        : 0,
      rollover_pending: run?.rolloverPending ? 1 : 0,
      session_count: state.sessions.length,
      log_count: state.logs.length,
      // v0.5: cost metrics
      session_cost_cents: run?.sessionCostCents ?? 0,
      total_cost_cents: run?.totalCostCents ?? 0,
      // timestamps
      updated_at: run?.updatedAt ?? null,
      run_id: run?.runId ?? null,
      phase: run?.phase ?? 'idle',
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics, null, 2));
    return;
  }

  // v0.5: export endpoint — full run data as downloadable JSON
  if (url.pathname === '/api/export') {
    const state = readAllState();
    const exportData = {
      exportedAt: new Date().toISOString(),
      dataDir: state.dataDir,
      run: state.run,
      settings: state.settings,
      sessions: state.sessions,
      logs: state.logs,
    };
    const filename = `goose-autonomous-${state.run?.runId?.slice(0, 8) ?? 'no-run'}-${Date.now()}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.end(JSON.stringify(exportData, null, 2));
    return;
  }

  // v0.5: health endpoint — for load balancers / process managers
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), dataDir: DATA_DIR }));
    return;
  }

  // v0.8: webhook delivery log endpoint
  // GET /api/webhooks?limit=100&runId=xxx — recent delivery records
  // DELETE /api/webhooks — clear the delivery log
  if (url.pathname === '/api/webhooks') {
    if (req.method === 'DELETE') {
      clearDeliveryLog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cleared: true }));
      return;
    }
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const runId = url.searchParams.get('runId') ?? undefined;
    const records = getDeliveryLog(limit, runId);
    // summary stats
    const summary = {
      total: records.length,
      delivered: records.filter((r) => r.result === 'delivered').length,
      failed: records.filter((r) => r.result === 'failed').length,
      skipped: records.filter((r) => r.result === 'skipped').length,
      signed: records.filter((r) => r.signed).length,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ records, summary }));
    return;
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const sendChange = () => res.write('event: change\ndata: {}\n\n');
    changeEmitter.on('change', sendChange);
    // keepalive ping every 15s
    const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      changeEmitter.off('change', sendChange);
      clearInterval(keepalive);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🪿  goose-autonomous-sessions monitor`);
  console.log(`   ─────────────────────────────────`);
  console.log(`   dashboard:  http://localhost:${PORT}`);
  console.log(`   data dir:   ${DATA_DIR}`);
  console.log(`   auth:       ${AUTH_TOKEN ? 'enabled (Bearer token)' : 'disabled (set AUTONOMOUS_DASHBOARD_TOKEN)'}`);
  console.log(`   endpoints:  /  /api/state  /api/metrics  /api/export  /api/health  /api/webhooks  /api/events`);
  console.log(`   auto-refresh: 1s + SSE live updates`);
  console.log(`\n   Press Ctrl+C to stop.\n`);
});
