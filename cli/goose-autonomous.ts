#!/usr/bin/env bun
//
// goose-autonomous — CLI tool for inspecting autonomous-session state.
//
// Usage:
//   bun cli/goose-autonomous.ts state [--data-dir DIR]
//   bun cli/goose-autonomous.ts logs [--data-dir DIR] [--limit N]
//   bun cli/goose-autonomous.ts webhooks [--data-dir DIR] [--limit N]
//   bun cli/goose-autonomous.ts sessions [--data-dir DIR]
//   bun cli/goose-autonomous.ts replay [--data-dir DIR] [--run-id ID]
//   bun cli/goose-autonomous.ts metrics [--data-dir DIR]
//
// If --data-dir is omitted, reads from ~/.config/Goose (the default Goose data dir).
//
// This CLI is a READ-ONLY inspector — it never modifies state. The only
// exception is `replay`, which re-attempts failed webhook deliveries.
//
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getDeliveryLog,
  getReplayableDeliveries,
  replayFailedDeliveries,
} from '../src/autonomous/webhooks';

// ─── args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] ?? 'state';

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const DATA_DIR = flag('--data-dir') ?? path.join(os.homedir(), '.config', 'Goose');
const LIMIT = Number(flag('--limit') ?? '50');
const RUN_ID = flag('--run-id');

// ─── helpers ───────────────────────────────────────────────────────────────────

function readJson<T>(file: string, fallback: T): T {
  const full = path.join(DATA_DIR, file);
  if (!existsSync(full)) return fallback;
  try {
    return JSON.parse(readFileSync(full, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function color(code: string, s: string): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s: string) => color('2', s);
const bold = (s: string) => color('1', s);
const green = (s: string) => color('32', s);
const red = (s: string) => color('31', s);
const amber = (s: string) => color('33', s);
const cyan = (s: string) => color('36', s);

// ─── commands ─────────────────────────────────────────────────────────────────

function cmdState(): void {
  const run = readJson<any>('autonomous-state.json', null);
  const settings = readJson<any>('autonomous-settings.json', { enabled: false, rolloverThreshold: 0.75 });
  console.log(bold('\n🪿 goose-autonomous-sessions — state\n'));
  console.log(`  data dir:   ${dim(DATA_DIR)}`);
  console.log(`  autonomous: ${settings.enabled ? green('ON') : dim('OFF')}`);
  console.log(`  threshold:  ${Math.round((settings.rolloverThreshold ?? 0.75) * 100)}%`);
  if (!run) {
    console.log(`\n  ${dim('No active run.')}\n`);
    return;
  }
  console.log(`\n  ${bold('Run')}`);
  console.log(`    runId:           ${run.runId}`);
  console.log(`    status:         ${run.status === 'active' ? green(run.status) : run.status === 'error' ? red(run.status) : run.status}`);
  console.log(`    phase:          ${run.phase}`);
  console.log(`    worker gen:     ${run.workerGeneration}`);
  console.log(`    verify attempt: ${run.verificationAttempt}`);
  const ctx = run.contextLimit ? Math.round(((run.contextUsage ?? 0) / run.contextLimit) * 100) : 0;
  console.log(`    context:        ${ctx}% (${run.contextUsage ?? 0}/${run.contextLimit ?? 0})`);
  console.log(`    rollover:       ${run.rolloverPending ? amber('PENDING') : 'idle'}`);
  if (run.turnsInCurrentSession !== undefined) {
    console.log(`    turns:          ${run.turnsInCurrentSession}`);
  }
  if (run.totalCostCents !== undefined && run.totalCostCents > 0) {
    console.log(`    total cost:     $${(run.totalCostCents / 100).toFixed(2)}`);
  }
  if (run.lastError) {
    console.log(`    ${red('error:')}          ${run.lastError}`);
  }
  console.log(`    updated:         ${run.updatedAt}`);
  console.log(`\n  ${bold('Objective')}`);
  console.log(`    ${run.originalObjective}`);
  console.log('');
}

function cmdLogs(): void {
  const file = path.join(DATA_DIR, 'autonomous.log.jsonl');
  if (!existsSync(file)) {
    console.log(dim('\nNo logs.\n'));
    return;
  }
  const data = readJson<{ logs: any[] }>('autonomous.log.jsonl', { logs: [] });
  const logs = data.logs ?? [];
  console.log(bold(`\n🪿 goose-autonomous-sessions — logs (${logs.length} entries, showing last ${LIMIT})\n`));
  const recent = logs.slice(-LIMIT).reverse();
  for (const l of recent) {
    const ts = new Date(l.ts).toLocaleTimeString();
    const level = l.level === 'error' ? red(l.level.padEnd(5)) : l.level === 'warn' ? amber(l.level.padEnd(5)) : green(l.level.padEnd(5));
    const tag = l.runId ? dim(`[${l.runId.slice(0, 8)}]`) : '';
    console.log(`  ${dim(ts)} ${level} ${tag} ${l.message}`);
  }
  console.log('');
}

function cmdWebhooks(): void {
  const records = getDeliveryLog(LIMIT, RUN_ID);
  console.log(bold(`\n🪿 goose-autonomous-sessions — webhook deliveries (${records.length} records${RUN_ID ? ` for ${RUN_ID.slice(0, 8)}` : ''})\n`));
  if (records.length === 0) {
    console.log(dim('  No webhook deliveries (in-memory log is per-process — start the dashboard to see live deliveries).\n'));
    return;
  }
  for (const r of records) {
    const result = r.result === 'delivered' ? green(r.result) : r.result === 'failed' ? red(r.result) : dim(r.result);
    const signed = r.signed ? cyan(' signed') : '';
    console.log(`  ${dim(new Date(r.attemptedAt).toLocaleTimeString())} ${r.event.padEnd(22)} ${result}${signed} attempt ${r.attempt} → ${r.url}`);
    if (r.error) console.log(`    ${red('error:')} ${r.error}`);
  }
  // summary
  const summary = {
    total: records.length,
    delivered: records.filter((r) => r.result === 'delivered').length,
    failed: records.filter((r) => r.result === 'failed').length,
    skipped: records.filter((r) => r.result === 'skipped').length,
  };
  console.log(`\n  ${bold('Summary:')} ${green(`${summary.delivered} delivered`)}, ${red(`${summary.failed} failed`)}, ${dim(`${summary.skipped} skipped`)}\n`);
}

function cmdSessions(): void {
  const data = readJson<{ sessions: any[] }>('autonomous-sessions.json', { sessions: [] });
  const sessions = data.sessions ?? [];
  console.log(bold(`\n🪿 goose-autonomous-sessions — sessions (${sessions.length})\n`));
  if (sessions.length === 0) {
    console.log(dim('  No sessions.\n'));
    return;
  }
  for (const s of sessions) {
    const status = s.status === 'completed' ? green(s.status) : s.status === 'failed' ? red(s.status) : s.status === 'active' ? amber(s.status) : dim(s.status);
    console.log(`  ${s.name.padEnd(24)} ${s.role.padEnd(12)} ${status}  ${dim(new Date(s.createdAt).toLocaleString())}`);
  }
  console.log('');
}

function cmdMetrics(): void {
  const run = readJson<any>('autonomous-state.json', null);
  const data = readJson<{ sessions: any[] }>('autonomous-sessions.json', { sessions: [] });
  console.log(bold('\n🪿 goose-autonomous-sessions — metrics\n'));
  if (!run) {
    console.log(dim('  No active run.\n'));
    return;
  }
  const ctx = run.contextLimit ? Math.round(((run.contextUsage ?? 0) / run.contextLimit) * 100) : 0;
  console.log(`  active             ${run.status === 'active' ? 1 : 0}`);
  console.log(`  completed          ${run.status === 'completed' ? 1 : 0}`);
  console.log(`  errored            ${run.status === 'error' ? 1 : 0}`);
  console.log(`  worker_generation  ${run.workerGeneration ?? 0}`);
  console.log(`  verification_attempt ${run.verificationAttempt ?? 0}`);
  console.log(`  context_usage_pct ${ctx}`);
  console.log(`  rollover_pending   ${run.rolloverPending ? 1 : 0}`);
  console.log(`  session_count      ${data.sessions?.length ?? 0}`);
  console.log(`  total_cost_cents   ${run.totalCostCents ?? 0}`);
  console.log(`  phase              ${run.phase}`);
  console.log('');
}

async function cmdReplay(): Promise<void> {
  const silentLogger = { info: async () => {}, warn: async () => {}, error: async () => {} };
  const count = await replayFailedDeliveries(silentLogger, RUN_ID);
  console.log(bold('\n🪿 goose-autonomous-sessions — replay\n'));
  console.log(`  ${green('Replayed')} ${count} failed webhook delivery(ies)${RUN_ID ? ` for run ${RUN_ID.slice(0, 8)}` : ''}.\n`);
  if (count === 0) {
    console.log(dim('  No replayable deliveries found. (Failed deliveries with stored payloads are replayable.)\n'));
  }
}

// ─── dispatch ─────────────────────────────────────────────────────────────────

switch (command) {
  case 'state': cmdState(); break;
  case 'logs': cmdLogs(); break;
  case 'webhooks': cmdWebhooks(); break;
  case 'sessions': cmdSessions(); break;
  case 'metrics': cmdMetrics(); break;
  case 'replay': await cmdReplay(); break;
  case 'help':
  case '--help':
  case '-h':
    console.log(bold('\n🪿 goose-autonomous-sessions — CLI\n'));
    console.log('  Commands:');
    console.log('    state       Show the current run state + settings');
    console.log('    logs        Show recent event log entries');
    console.log('    webhooks    Show webhook delivery log (use --run-id to filter)');
    console.log('    sessions    Show session lineage');
    console.log('    metrics     Show compact metrics (Prometheus-friendly)');
    console.log('    replay      Re-attempt failed webhook deliveries');
    console.log('');
    console.log('  Flags:');
    console.log('    --data-dir DIR   Override the data directory (default: ~/.config/Goose)');
    console.log('    --limit N        Number of entries to show (default: 50)');
    console.log('    --run-id ID      Filter by run ID');
    console.log('');
    break;
  default:
    console.log(red(`\n  Unknown command: ${command}`));
    console.log(dim('  Run with --help for usage.\n'));
    process.exit(1);
}
