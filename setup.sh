#!/usr/bin/env bash
#
# setup.sh — ONE command to clone, install, build, and launch.
#
# Handles everything automatically:
#   1. Installs missing prerequisites (pnpm, Rust) if needed
#   2. Clones Goose source at the pinned commit (or reuses existing)
#   3. Resets Goose to a clean state (stashes any prior changes)
#   4. Copies the autonomous module + adapters
#   5. Applies all 5 patches
#   6. Builds the customized Goose Desktop
#   7. Launches it
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
    --no-build)  LAUNCH=false ;;  # alias
    *)           CLONE_DIR="$arg" ;;
  esac
done

echo ""
bold "🪿 goose-autonomous-sessions — automated setup"
echo "   clone → install → build → launch"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 1: Prerequisites — install if missing
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 1/7: Prerequisites ───"
echo ""

# Linux check
if [[ "$(uname -s)" != "Linux" ]]; then
  red "✗ Linux required (got $(uname -s))."
  exit 1
fi
green "✓ Linux"

# git
if ! command -v git >/dev/null 2>&1; then
  yellow "  git not found — installing..."
  sudo apt-get update -qq && sudo apt-get install -y -qq git >/dev/null 2>&1 || {
    red "✗ Could not install git. Run: sudo apt install git"
    exit 1
  }
fi
green "✓ git"

# bun (for running the autonomous module + demos)
if ! command -v bun >/dev/null 2>&1; then
  yellow "  bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || {
    yellow "  Could not auto-install bun (not critical for Goose build)."
  }
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 && green "✓ bun $(bun --version)" || yellow "⚠  bun not installed (optional — needed for demos/dashboard)"

# node (needed by Goose Desktop build)
if ! command -v node >/dev/null 2>&1; then
  yellow "  node not found — installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1 || true
  sudo apt-get install -y -qq nodejs >/dev/null 2>&1 || {
    red "✗ Could not install node. Install manually: https://nodejs.org/"
    exit 1
  }
fi
green "✓ node $(node --version)"

# pnpm (Goose Desktop's package manager)
if ! command -v pnpm >/dev/null 2>&1; then
  yellow "  pnpm not found — installing..."
  npm install -g pnpm >/dev/null 2>&1 || sudo npm install -g pnpm >/dev/null 2>&1 || {
    red "✗ Could not install pnpm. Run: npm install -g pnpm"
    exit 1
  }
fi
green "✓ pnpm $(pnpm --version)"

# Rust/Cargo (Goose's native crates)
if ! command -v cargo >/dev/null 2>&1; then
  yellow "  cargo (Rust) not found — installing rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y >/dev/null 2>&1 || {
    red "✗ Could not install Rust. Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
  }
  source "$HOME/.cargo/env"
fi
green "✓ cargo $(cargo --version)"

# Build tools
if ! command -v make >/dev/null 2>&1; then
  yellow "  build-essential not found — installing..."
  sudo apt-get install -y -qq build-essential pkg-config libssl-dev >/dev/null 2>&1 || true
fi
green "✓ build tools"

echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 2: Clone Goose source (or reuse existing)
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 2/7: Clone Goose source ───"
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

bold "─── Step 3/7: Reset to pinned commit (clean state) ───"
echo ""

cd "$CLONE_DIR"

# Fetch the pinned commit if not present
if ! git rev-parse --verify "$PINNED" >/dev/null 2>&1; then
  echo "  Fetching pinned commit..."
  git fetch origin "$PINNED" 2>/dev/null || git fetch --depth 1 origin "$PINNED" 2>/dev/null || git fetch origin 2>/dev/null || true
fi

# Discard ALL local changes + untracked files (from any prior install attempt)
echo "  Discarding any prior changes..."
git checkout . 2>/dev/null || true
git clean -fd ui/desktop/src/autonomous ui/desktop/src/adapters 2>/dev/null || true

# Check out the pinned commit
git checkout "$PINNED" 2>&1 | tail -1
HEAD=$(git rev-parse HEAD)
if [[ "$HEAD" != "$PINNED" ]]; then
  red "✗ Failed to check out pinned commit (HEAD is ${HEAD:0:12})"
  exit 1
fi
green "✓ At pinned commit: ${PINNED:0:12}"

# Verify clean
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  yellow "  Stashing remaining changes..."
  git stash 2>/dev/null || git checkout . 2>/dev/null || true
fi
green "✓ Git tree is clean"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 4: Install the autonomous module
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 4/7: Install autonomous module + adapters ───"
echo ""

# Copy the module
MODULE_SRC="$SCRIPT_DIR/src/autonomous"
MODULE_DST="$CLONE_DIR/ui/desktop/src/autonomous"
mkdir -p "$MODULE_DST"
cp "$MODULE_SRC"/*.ts "$MODULE_DST/"
green "✓ Module: $(ls "$MODULE_DST"/*.ts | wc -l) files → ui/desktop/src/autonomous/"

# Copy adapters
ADAPTER_SRC="$SCRIPT_DIR/adapters"
ADAPTER_DST="$CLONE_DIR/ui/desktop/src/adapters"
mkdir -p "$ADAPTER_DST"
cp "$ADAPTER_SRC"/*.ts "$ADAPTER_DST/"
green "✓ Adapters: $(ls "$ADAPTER_DST"/*.ts | wc -l) files → ui/desktop/src/adapters/"

# Generate the controller singleton
cat > "$MODULE_DST/index.ts" <<'TS'
// src/autonomous/index.ts — auto-generated by setup.sh
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

export { AutonomousSessionController } from './controller';
export * from './types';
export * from './constants';
export * from './handoff';
export * from './handoff-schema';
export * from './rollover-policy';
export * from './webhooks';
export * from './contextMonitor';
export * from './completionDetector';
export * from './stateStore';
export * from './sessionManager';
export * from './navigation';
export * from './recovery';
export * from './logger';
TS
green "✓ Controller singleton wired"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 5: Apply patches
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 5/7: Apply patches ───"
echo ""

PATCH_DIR="$SCRIPT_DIR/patches"
PATCHES=(
  "0001-add-autonomous-event.patch"
  "0002-add-settings-field.patch"
  "0003-wire-useChatSession.patch"
  "0004-wire-navigation.patch"
  "0005-add-electron-ipc.patch"
)

for patch in "${PATCHES[@]}"; do
  if git apply --whitespace=fix "$PATCH_DIR/$patch" 2>/dev/null; then
    green "✓ $patch"
  else
    # Check if already applied (idempotent)
    if grep -q "autonomousController" "$CLONE_DIR/ui/desktop/src/hooks/useChatSession.ts" 2>/dev/null && [[ "$patch" == *"useChatSession"* ]]; then
      yellow "⚠  $patch — already applied (skipping)"
    elif grep -q "GOOSE_AUTONOMOUS_SWITCH_SESSION" "$CLONE_DIR/ui/desktop/src/constants/events.ts" 2>/dev/null && [[ "$patch" == *"autonomous-event"* ]]; then
      yellow "⚠  $patch — already applied (skipping)"
    else
      red "✗ Failed: $patch"
      exit 1
    fi
  fi
done
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 6: Build the customized Goose Desktop
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 6/7: Build Goose Desktop ───"
echo ""

cd "$CLONE_DIR/ui/desktop"

echo "  Installing dependencies (this may take a few minutes)..."
pnpm install 2>&1 | tail -3

echo ""
echo "  Building (this may take several minutes)..."
pnpm build 2>&1 | tail -5

if [[ $? -ne 0 ]]; then
  red "✗ Build failed. See output above."
  echo ""
  echo "  Common fixes:"
  echo "    - Missing system deps: sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev"
  echo "    - Rust not in PATH: source ~/.cargo/env"
  echo ""
  exit 1
fi
green "✓ Build complete"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 7: Launch
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 7/7: Launch ───"
echo ""

green "✓ Everything is ready!"
echo ""
echo "  Goose source:       $CLONE_DIR"
echo "  Customized Desktop: $CLONE_DIR/ui/desktop"
echo ""

if $LAUNCH; then
  bold "  Launching Goose Desktop..."
  echo ""
  pnpm start 2>&1 || npx electron . 2>&1 || {
    yellow "  Could not auto-launch. Start it manually:"
    echo "    cd $CLONE_DIR/ui/desktop"
    echo "    pnpm start    # or: npx electron ."
  }
else
  bold "  To launch manually:"
  echo "    cd $CLONE_DIR/ui/desktop"
  echo "    pnpm start    # or: npx electron ."
  echo ""
  bold "  To enable Autonomous Sessions:"
  echo "    1. Open Settings in Goose Desktop"
  echo "    2. Toggle 'Autonomous Sessions' ON"
  echo "    3. Set threshold (default 75%)"
  echo "    4. Start a task and walk away"
fi
echo ""
bold "  To uninstall later:"
echo "    cd $SCRIPT_DIR && ./uninstall.sh $CLONE_DIR"
echo ""
