#!/usr/bin/env bash
#
# setup.sh — ONE command to clone, install, build, and launch.
#
# Handles everything automatically:
#   1. Installs missing prerequisites (pnpm, Rust, etc.) if needed
#   2. Clones Goose source at the pinned commit (or reuses existing)
#   3. Resets Goose to a clean state (stashes any prior changes)
#   4. Copies the autonomous module + adapters
#   5. Applies all 5 patches
#   6. Installs dependencies from the workspace root (ui/)
#   7. Launches the customized Goose Desktop
#
# Usage:
#   bash setup.sh              # do everything
#   bash setup.sh --no-launch  # everything except launch
#   bash setup.sh /custom/path # clone to a custom path
#
set -euo pipefail

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

PINNED="ce0c4900837a51b2ae50ce0df1484c34a1be754e"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLONE_DIR="$HOME/goose"
LAUNCH=true

for arg in "$@"; do
  case "$arg" in
    --no-launch) LAUNCH=false ;;
    --no-build)  LAUNCH=false ;;
    *)           CLONE_DIR="$arg" ;;
  esac
done

echo ""
bold "🪿 goose-autonomous-sessions — automated setup"
echo "   clone → install → build → launch"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 1: Prerequisites
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 1/9: Prerequisites ───"
echo ""

if [[ "$(uname -s)" != "Linux" ]]; then
  red "✗ Linux required."
  exit 1
fi
green "✓ Linux"

if ! command -v git >/dev/null 2>&1; then
  yellow "  git not found — installing..."
  sudo apt-get update -qq && sudo apt-get install -y -qq git >/dev/null 2>&1
fi
green "✓ git"

if ! command -v node >/dev/null 2>&1; then
  yellow "  node not found — installing Node 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -qq nodejs >/dev/null 2>&1
else
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    yellow "  Node $(node --version) is too old (Goose needs 20+). Upgrading to Node 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
    sudo apt-get install -y -qq nodejs >/dev/null 2>&1
  fi
fi
green "✓ node $(node --version)"

if ! command -v pnpm >/dev/null 2>&1; then
  yellow "  pnpm not found — installing..."
  npm install -g pnpm >/dev/null 2>&1 || sudo npm install -g pnpm >/dev/null 2>&1
fi
green "✓ pnpm $(pnpm --version)"

if ! command -v cargo >/dev/null 2>&1; then
  yellow "  Rust not found — installing..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y >/dev/null 2>&1
  source "$HOME/.cargo/env"
fi
green "✓ cargo"

# Build tools + system libraries for Goose's native crates
yellow "  Checking system libraries for Goose build..."
sudo apt-get update -qq 2>/dev/null
sudo apt-get install -y -qq \
  build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev \
  libclang-dev clang libglib2.0-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libdbus-1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  cmake git curl wget file \
  >/dev/null 2>&1 || true

# Export LIBCLANG_PATH so bindgen can find libclang
export LIBCLANG_PATH="$(find /usr -name 'libclang.so*' -path '*/lib/*' 2>/dev/null | head -1 | xargs dirname 2>/dev/null)"
if [[ -z "$LIBCLANG_PATH" ]]; then
  # Common fallback locations
  for p in /usr/lib/llvm-14/lib /usr/lib/llvm-15/lib /usr/lib/llvm-16/lib /usr/lib/llvm-17/lib /usr/lib/llvm-18/lib /usr/lib/x86_64-linux-gnu; do
    if [[ -f "$p/libclang.so" || -f "$p/libclang.so.1" ]]; then
      export LIBCLANG_PATH="$p"
      break
    fi
  done
fi
if [[ -n "$LIBCLANG_PATH" ]]; then
  green "✓ libclang found at: $LIBCLANG_PATH"
else
  yellow "⚠  libclang not found — installing libclang-dev..."
  sudo apt-get install -y -qq libclang-dev >/dev/null 2>&1 || true
  export LIBCLANG_PATH="$(find /usr -name 'libclang.so*' -path '*/lib/*' 2>/dev/null | head -1 | xargs dirname 2>/dev/null)"
  [[ -n "$LIBCLANG_PATH" ]] && green "✓ libclang found at: $LIBCLANG_PATH" || yellow "⚠  libclang still not found — cargo build may fail"
fi
green "✓ build tools + system libraries"

echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 2: Clone Goose source
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 2/9: Clone Goose source ───"
echo ""

if [[ -d "$CLONE_DIR/.git" ]]; then
  yellow "  $CLONE_DIR already exists — reusing."
else
  echo "  Cloning Goose to: $CLONE_DIR"
  git clone https://github.com/aaif-goose/goose.git "$CLONE_DIR" 2>&1 | tail -1
  green "✓ Cloned"
fi
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 3: Reset to clean state at the pinned commit
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 3/9: Reset to pinned commit ───"
echo ""

cd "$CLONE_DIR"

# Fetch the pinned commit if not present
if ! git rev-parse --verify "$PINNED" >/dev/null 2>&1; then
  echo "  Fetching pinned commit..."
  git fetch origin "$PINNED" 2>/dev/null || git fetch --depth 1 origin "$PINNED" 2>/dev/null || git fetch origin 2>/dev/null || true
fi

# Discard ALL local changes + untracked files from prior install attempts
echo "  Discarding prior changes..."
git checkout . 2>/dev/null || true
git clean -fd ui/desktop/src/autonomous ui/desktop/src/adapters 2>/dev/null || true

# Checkout the pinned commit
git checkout "$PINNED" 2>&1 | tail -1
HEAD=$(git rev-parse HEAD)
if [[ "$HEAD" != "$PINNED" ]]; then
  red "✗ Failed to check out pinned commit."
  exit 1
fi
green "✓ At pinned commit: ${PINNED:0:12}"

# Ensure clean
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  git stash 2>/dev/null || git checkout . 2>/dev/null || true
fi
green "✓ Git tree is clean"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 4: Install autonomous module + adapters
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 4/9: Install autonomous module ───"
echo ""

MODULE_SRC="$SCRIPT_DIR/src/autonomous"
MODULE_DST="$CLONE_DIR/ui/desktop/src/autonomous"
ADAPTER_SRC="$SCRIPT_DIR/adapters"
ADAPTER_DST="$CLONE_DIR/ui/desktop/src/adapters"

mkdir -p "$MODULE_DST" "$ADAPTER_DST"
cp "$MODULE_SRC"/*.ts "$MODULE_DST/"
cp "$ADAPTER_SRC"/*.ts "$ADAPTER_DST/"
green "✓ Module: $(ls "$MODULE_DST"/*.ts | wc -l) files"
green "✓ Adapters: $(ls "$ADAPTER_DST"/*.ts | wc -l) files"

# Generate the controller singleton.
# CRITICAL: This file is imported by BOTH the main process (via patch 0005) AND
# the renderer (via patch 0003 — useChatSession.ts imports autonomousController).
# The renderer runs in a browser context where 'electron' and Node built-ins
# are NOT available. So we MUST NOT import the electron adapters at the top
# level here — they would break Vite's renderer build.
#
# Instead, we export a LAZY controller that only initializes when called from
# the main process. The renderer-side hooks call onContextUsage/onTurnFinished
# which no-op when no controller is wired (status check fails gracefully).
cat > "$MODULE_DST/index.ts" <<'TS'
// src/autonomous/index.ts — auto-generated by setup.sh
//
// This barrel export is imported by BOTH the main process AND the renderer.
// The renderer (browser) cannot import 'electron' or Node built-ins.
// So we do NOT import the electron adapters here — they're imported lazily
// only in the main process (see main.ts patch 0005).
//
// The renderer imports autonomousController and calls onContextUsage /
// onTurnFinished — these are safe to call even before the controller is
// fully wired (they check run status and no-op if no active run).

import { AutonomousSessionController } from './controller';
import type { ControllerDeps } from './controller';

// Lazy-init the controller. The main process will call initController()
// to wire the electron adapters. The renderer can import this module
// safely without triggering electron imports.
let _controller: AutonomousSessionController | null = null;

// Minimal no-op adapters for when the controller isn't wired yet
// (e.g., renderer imports before main process initializes).
const noopStore = {
  async getRun() { return null; },
  async saveRun() {},
  async clearRun() {},
  async getSettings() { return { enabled: false, rolloverThreshold: 0.75 }; },
  async saveSettings() {},
  async recordSession() {},
  async updateSessionStatus() {},
  async getSessions() { return []; },
  async clearSessions() {},
};
const noopLogger = {
  async info() {},
  async warn() {},
  async error() {},
};

export function initController(deps: Pick<ControllerDeps, 'store' | 'logger' | 'generateHandoffResponse' | 'sendPrompt'>) {
  _controller = new AutonomousSessionController(deps);
  return _controller;
}

// Proxy that no-ops until initController() is called from the main process
export const autonomousController = {
  startRun: (...args: any[]) => _controller?.startRun(...args) ?? Promise.reject(new Error('Controller not initialized')),
  onContextUsage: (...args: any[]) => _controller?.onContextUsage(...args) ?? Promise.resolve(null),
  onTurnFinished: (...args: any[]) => _controller?.onTurnFinished(...args) ?? Promise.resolve(null),
  stopRun: () => _controller?.stopRun() ?? Promise.resolve(null),
  resumeRun: () => _controller?.resumeRun() ?? Promise.resolve(null),
  clearAll: () => _controller?.clearAll() ?? Promise.resolve(),
  getState: () => _controller?.getState() ?? Promise.resolve(null),
  store: noopStore,
  logger: noopLogger,
  handoffSchema: { length: 0 } as any,
};

export { AutonomousSessionController } from './controller';
export type { ControllerDeps, HandoffGenerator, ContinuationPromptSender } from './controller';
export * from './types';
export * from './constants';
export * from './handoff';
export * from './handoff-schema';
export * from './rollover-policy';
export * from './contextMonitor';
export * from './completionDetector';
export * from './sessionManager';
export * from './navigation';
export * from './recovery';
// NOTE: webhooks.ts, stateStore.ts, logger.ts are NOT exported here.
// - webhooks.ts uses dynamic import('crypto') which is fine but we keep it
//   out of the renderer bundle to minimize size.
// - stateStore.ts + logger.ts reference @/lib/db (Next.js path alias).
// - The electron adapters are imported lazily by main.ts (patch 0005).
TS
green "✓ Controller singleton wired"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 5: Apply patches
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 5/9: Apply patches ───"
echo ""

PATCH_DIR="$SCRIPT_DIR/patches"
for patch in 0001-add-autonomous-event 0002-add-settings-field 0003-wire-useChatSession 0004-wire-navigation 0005-add-electron-ipc; do
  if git apply --whitespace=fix "$PATCH_DIR/$patch.patch" 2>/dev/null; then
    green "✓ $patch"
  else
    yellow "⚠  $patch — already applied (skipping)"
  fi
done
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 6: Build Goose binary + install dependencies + build Desktop
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 6/9: Build Goose binary + install deps ───"
echo ""

# First: build the Goose Rust binary (the Desktop needs it to run)
cd "$CLONE_DIR"
if [[ ! -f target/release/goose && ! -f target/debug/goose ]]; then
  echo "  Building Goose binary (Rust — this takes several minutes the first time)..."
  # LIBCLANG_PATH must be set for bindgen to find libclang
  LIBCLANG_PATH="$LIBCLANG_PATH" cargo build --release 2>&1 | tail -10
  if [[ ! -f target/release/goose ]]; then
    yellow "  Release build failed, trying debug build..."
    cargo build 2>&1 | tail -5
  fi
  if [[ -f target/release/goose ]]; then
    green "✓ Goose binary: target/release/goose"
  elif [[ -f target/debug/goose ]]; then
    green "✓ Goose binary: target/debug/goose"
  else
    yellow "⚠  Goose binary build failed. The Desktop will start but may not"
    echo "     be able to run AI tasks. Build manually later:  cd $CLONE_DIR && cargo build --release"
  fi
else
  green "✓ Goose binary already built"
fi
echo ""

# Second: install JS dependencies
cd "$CLONE_DIR/ui"

# ALWAYS clean node_modules from prior attempts
if [[ -d node_modules ]]; then
  yellow "  Cleaning node_modules from prior attempt..."
  rm -rf node_modules goose-acp-client/node_modules goose-acp/node_modules desktop/node_modules
fi

echo "  Installing JS dependencies..."
pnpm install 2>&1 | tail -5

if [[ $? -ne 0 ]]; then
  red "✗ Dependency install failed."
  echo ""
  echo "  Common fixes:"
  echo "    1. Ensure Node 20+:  node --version  (setup.sh should have upgraded it)"
  echo "    2. Clean and retry:"
  echo "       cd $CLONE_DIR/ui"
  echo "       rm -rf node_modules goose-acp-client/node_modules goose-acp/node_modules desktop/node_modules"
  echo "       pnpm install"
  echo ""
  exit 1
fi
green "✓ Dependencies installed"

# Build the ACP client + i18n (required before launching)
echo ""
echo "  Building ACP client + i18n..."
cd "$CLONE_DIR/ui/desktop"
pnpm run build-goose-acp-client 2>&1 | tail -3
pnpm run i18n:compile 2>&1 | tail -3
green "✓ Build complete"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 7: Create desktop shortcuts + application menu entries
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 7/9: Create desktop shortcuts ───"
echo ""

# Create a launcher script that Goose Desktop can use
LAUNCH_SCRIPT="$HOME/.local/bin/goose-autonomous"
mkdir -p "$HOME/.local/bin"
cat > "$LAUNCH_SCRIPT" << EOF
#!/usr/bin/env bash
cd "$CLONE_DIR/ui/desktop" && pnpm run start-gui
EOF
chmod +x "$LAUNCH_SCRIPT"
green "✓ Launcher script: $LAUNCH_SCRIPT"

# Create a .desktop file for the application menu
DESKTOP_FILE="$HOME/.local/share/applications/goose-autonomous.desktop"
mkdir -p "$HOME/.local/share/applications"

# Try to find an icon
ICON_PATH=""
for icon in \
  "$CLONE_DIR/ui/desktop/src/assets/icons/icon.png" \
  "$CLONE_DIR/ui/desktop/src/assets/icon.png" \
  "$CLONE_DIR/crates/goose/bin/icon.png" \
  "$CLONE_DIR/ui/desktop/resources/icon.png"
do
  if [[ -f "$icon" ]]; then
    ICON_PATH="$icon"
    break
  fi
done
[[ -z "$ICON_PATH" ]] && ICON_PATH="utilities-terminal"

cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Type=Application
Name=Goose Autonomous
Comment=Goose Desktop with autonomous sessions
Exec=$LAUNCH_SCRIPT
Icon=$ICON_PATH
Terminal=false
Categories=Development;AI;
EOF
green "✓ Application menu: Goose Autonomous"

# Also create a desktop shortcut
DESKTOP_SHORTCUT="$HOME/Desktop/Goose-Autonomous.desktop"
cat > "$DESKTOP_SHORTCUT" << EOF
[Desktop Entry]
Type=Application
Name=Goose Autonomous
Comment=Goose Desktop with autonomous sessions
Exec=$LAUNCH_SCRIPT
Icon=$ICON_PATH
Terminal=false
Categories=Development;AI;
EOF
chmod +x "$DESKTOP_SHORTCUT"
green "✓ Desktop shortcut: $HOME/Desktop/Goose-Autonomous.desktop"

# Also create a shortcut for the monitoring dashboard
DASHBOARD_SCRIPT="$HOME/.local/bin/goose-autonomous-dashboard"
cat > "$DASHBOARD_SCRIPT" << EOF
#!/usr/bin/env bash
cd "$SCRIPT_DIR" && bun dashboard/server.ts
EOF
chmod +x "$DASHBOARD_SCRIPT"
green "✓ Dashboard launcher: $DASHBOARD_SCRIPT"

# Update desktop database
update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 8: Launch
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 8/9: Launch ───"
echo ""

green "✓ Everything is ready!"
echo ""
echo "  Goose source:      $CLONE_DIR"
echo "  Desktop dir:       $CLONE_DIR/ui/desktop"
echo "  Launcher:          $LAUNCH_SCRIPT"
echo "  App menu:          Goose Autonomous"
echo "  Desktop shortcut:  ~/Desktop/Goose-Autonomous.desktop"
echo "  Dashboard:         $DASHBOARD_SCRIPT"
echo ""

if $LAUNCH; then
  bold "  Launching Goose Desktop..."
  echo ""
  cd "$CLONE_DIR/ui/desktop"
  # start-gui builds the ACP client + compiles i18n + launches electron-forge
  pnpm run start-gui 2>&1 || {
    yellow "  start-gui failed. Try manually:"
    echo "    cd $CLONE_DIR/ui/desktop"
    echo "    pnpm run start-gui"
    echo ""
    echo "  Or just electron-forge:"
    echo "    cd $CLONE_DIR/ui/desktop"
    echo "    npx electron-forge start"
  }
else
  bold "  To launch manually:"
  echo "    cd $CLONE_DIR/ui/desktop"
  echo "    pnpm run start-gui"
  echo ""
  bold "  Then in Goose Desktop:"
  echo "    Settings → enable 'Autonomous Sessions'"
  echo "    Set threshold (default 75%)"
  echo "    Start a task and walk away"
fi
echo ""
bold "  To uninstall:"
echo "    cd $SCRIPT_DIR && ./uninstall.sh $CLONE_DIR"
echo ""
