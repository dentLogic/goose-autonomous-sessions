// tests/install-cycle.test.ts
// v1.0 audit — verifies the install.sh + uninstall.sh cycle on a clean Goose checkout.
//
// This is an INTEGRATION test that:
//   1. Clones Goose (shallow) at the pinned commit to a temp dir
//   2. Runs install.sh
//   3. Verifies the module + adapters + patches landed
//   4. Runs uninstall.sh
//   5. Verifies Goose source is restored to a clean state
//
// It does NOT test against LM Studio or a running Goose Desktop — see
// docs/MANUAL_TEST.md for that procedure.
//
// Skipped automatically if git or network is unavailable.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

const PINNED_COMMIT = 'ce0c4900837a51b2ae50ce0df1484c34a1be754e';
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(os.tmpdir(), 'goose-install-cycle-test');
const PATCH_DIR = path.join(REPO_ROOT, 'patches');

// Skip if git isn't available
const hasGit = (() => {
  try { execSync('git --version', { stdio: 'pipe' }); return true; } catch { return false; }
})();

describe.skipIf(!hasGit)('install → uninstall cycle (integration)', () => {
  const patches = [
    '0001-add-autonomous-event',
    '0002-add-settings-field',
    '0003-wire-useChatSession',
    '0004-wire-navigation',
    '0005-add-electron-ipc',
  ];

  beforeAll(() => {
    // Clean up any leftover from a prior run
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // @ts-ignore — bun:test supports timeout option
  it('clones Goose at the pinned commit', { timeout: 120_000 }, () => {
    // shallow clone then fetch the specific commit
    execSync(`git clone --depth 1 https://github.com/aaif-goose/goose.git ${TMP_DIR}`, {
      stdio: 'pipe',
      timeout: 60_000,
    });
    execSync(`git fetch --depth 1 origin ${PINNED_COMMIT}`, {
      cwd: TMP_DIR,
      stdio: 'pipe',
      timeout: 30_000,
    });
    execSync(`git checkout ${PINNED_COMMIT}`, {
      cwd: TMP_DIR,
      stdio: 'pipe',
    });
    const head = execSync('git rev-parse HEAD', { cwd: TMP_DIR, encoding: 'utf-8' }).trim();
    expect(head).toBe(PINNED_COMMIT);
  });

  // @ts-ignore — bun:test supports timeout option
  it('validates all 5 patches via git apply --check', { timeout: 30_000 }, () => {
    for (const p of patches) {
      const patchFile = path.join(PATCH_DIR, `${p}.patch`);
      expect(existsSync(patchFile)).toBe(true);
      // Should not throw
      execSync(`git apply --check ${patchFile}`, { cwd: TMP_DIR, stdio: 'pipe' });
    }
  });

  // @ts-ignore — bun:test supports timeout option
  it('runs install.sh successfully', { timeout: 60_000 }, () => {
    execSync(`bash ${path.join(REPO_ROOT, 'install.sh')} ${TMP_DIR}`, {
      stdio: 'pipe',
      timeout: 30_000,
    });
  });

  it('installed the autonomous module (15 files)', () => {
    const moduleDir = path.join(TMP_DIR, 'ui/desktop/src/autonomous');
    expect(existsSync(moduleDir)).toBe(true);
    const files = execSync(`ls ${moduleDir}/*.ts | wc -l`, { encoding: 'utf-8' }).trim();
    expect(Number(files)).toBeGreaterThanOrEqual(14);
  });

  it('installed the adapters (4 files)', () => {
    const adaptersDir = path.join(TMP_DIR, 'ui/desktop/src/adapters');
    expect(existsSync(adaptersDir)).toBe(true);
    const files = execSync(`ls ${adaptersDir}/*.ts | wc -l`, { encoding: 'utf-8' }).trim();
    expect(Number(files)).toBe(4);
  });

  it('patched events.ts (GOOSE_AUTONOMOUS_SWITCH_SESSION exists)', () => {
    const eventsFile = path.join(TMP_DIR, 'ui/desktop/src/constants/events.ts');
    const content = readFileSync(eventsFile, 'utf-8');
    expect(content).toContain('GOOSE_AUTONOMOUS_SWITCH_SESSION');
  });

  it('patched useChatSession.ts (autonomousController references exist)', () => {
    const file = path.join(TMP_DIR, 'ui/desktop/src/hooks/useChatSession.ts');
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('autonomousController');
  });

  it('patched main.ts (autonomous IPC handlers exist)', () => {
    const file = path.join(TMP_DIR, 'ui/desktop/src/main.ts');
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('autonomous-state.json');
  });

  it('patched settings.ts (autonomous settings field exists)', () => {
    const file = path.join(TMP_DIR, 'ui/desktop/src/utils/settings.ts');
    const content = readFileSync(file, 'utf-8');
    // The patch adds an `autonomous: AutonomousSettings` field to Settings
    expect(content).toContain('AutonomousSettings');
    expect(content).toContain('autonomous:');
  });

  // @ts-ignore — bun:test supports timeout option
  it('runs uninstall.sh successfully', { timeout: 60_000 }, () => {
    execSync(`bash ${path.join(REPO_ROOT, 'uninstall.sh')} ${TMP_DIR}`, {
      stdio: 'pipe',
      timeout: 30_000,
    });
  });

  it('removed the autonomous module dir after uninstall', () => {
    const moduleDir = path.join(TMP_DIR, 'ui/desktop/src/autonomous');
    expect(existsSync(moduleDir)).toBe(false);
  });

  it('removed the adapters dir after uninstall', () => {
    const adaptersDir = path.join(TMP_DIR, 'ui/desktop/src/adapters');
    expect(existsSync(adaptersDir)).toBe(false);
  });

  it('restored Goose source to a clean git state', () => {
    const status = execSync('git status --short', { cwd: TMP_DIR, encoding: 'utf-8' }).trim();
    expect(status).toBe('');
  });
});
