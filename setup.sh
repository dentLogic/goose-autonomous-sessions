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

bold "─── Step 1/8: Prerequisites ───"
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
  yellow "  node not found — installing..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -qq nodejs >/dev/null 2>&1
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

# Build tools for native modules
if ! command -v make >/dev/null 2>&1; then
  yellow "  build-essential not found — installing..."
  sudo apt-get install -y -qq build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev >/dev/null 2>&1 || true
fi
green "✓ build tools"

echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 2: Clone Goose source
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 2/8: Clone Goose source ───"
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

bold "─── Step 3/8: Reset to pinned commit ───"
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

bold "─── Step 4/8: Install autonomous module ───"
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

# Generate the controller singleton
cat > "$MODULE_DST/index.ts" <<'TS'
import { AutonomousSessionController } from './controller';
import { electronStateStore } from '../adapters/electron-state-store';
import { electronLogger } from '../adapters/electron-logger';
import { acpHandoffGenerator, acpSendPrompt } from '../adapters/acp-integration';
export const autonomousController = new AutonomousSessionController({
  store: electronStateStore, logger: electronLogger,
  generateHandoffResponse: acpHandoffGenerator, sendPrompt: acpSendPrompt,
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

bold "─── Step 5/8: Apply patches ───"
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
# Step 6: Install dependencies + build (from workspace root ui/)
# ═══════════════════════════════════════════════════════════════════════════

bold "─── Step 6/8: Install dependencies + build ───"
echo ""

# Goose uses a pnpm workspace at ui/ — must install from there
cd "$CLONE_DIR/ui"

# Clean any broken partial install from prior attempts
if [[ -d node_modules && ! -f node_modules/.bin/tsx ]]; then
  yellow "  Cleaning broken node_modules from prior attempt..."
  rm -rf node_modules
  # Also clean workspace member node_modules
  rm -rf goose-acp-client/node_modules goose-acp/node_modules desktop/node_modules
fi

echo "  Installing dependencies (this takes a few minutes)..."
pnpm install 2>&1 | tail -5

if [[ $? -ne 0 ]]; then
  red "✗ Dependency install failed."
  echo ""
  echo "  Try cleaning and re-running:"
  echo "    cd $CLONE_DIR/ui"
  echo "    rm -rf node_modules goose-acp-client/node_modules goose-acp/node_modules desktop/node_modules"
  echo "    pnpm install"
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

bold "─── Step 7/8: Create desktop shortcuts ───"
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

bold "─── Step 8/8: Launch ───"
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
