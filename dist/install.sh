#!/usr/bin/env bash
#
# goose-autonomous-sessions — installer (v0.2)
#
# Installs the portable autonomous-session module + applies the validated
# lifecycle patches into a local Goose Desktop source checkout.
#
# Safe by design:
#   ✓ Validates Linux
#   ✓ Verifies the Goose source layout
#   ✓ Verifies the git tree is clean
#   ✓ Verifies the pinned Goose commit matches (or warns + asks)
#   ✓ Creates a backup branch
#   ✓ Copies src/autonomous/ + adapters/ into ui/desktop/src/
#   ✓ Validates + applies the .patch files from patches/
#   ✓ Optionally builds the customized Desktop
#   ✓ Prints exactly what changed
#
# Usage:
#   ./install.sh /path/to/goose [--build]
#   GOOSE_SOURCE=/path/to/goose ./install.sh [--build]
#
set -euo pipefail

GOOSE_SOURCE="${1:-${GOOSE_SOURCE:-}}"
shift || true
BUILD_DESKTOP=false
for arg in "$@"; do
  case "$arg" in
    --build) BUILD_DESKTOP=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

echo ""
bold "🪿 goose-autonomous-sessions — installer (v0.2)"
echo ""

# ─── 1. verify Linux ──────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  red "✗ Linux required (got $(uname -s)). macOS/Windows support is not in v0.2."
  exit 1
fi
green "✓ Linux"

# ─── 2. locate Goose source ───────────────────────────────────────────────────
if [[ -z "$GOOSE_SOURCE" ]]; then
  red "✗ Goose source path required."
  echo "  Usage:  ./install.sh /path/to/goose [--build]"
  echo "     or:  GOOSE_SOURCE=/path/to/goose ./install.sh"
  exit 1
fi
if [[ ! -d "$GOOSE_SOURCE" ]]; then
  red "✗ Goose source not found: $GOOSE_SOURCE"
  exit 1
fi
green "✓ Goose source: $GOOSE_SOURCE"

# ─── 3. verify Goose source layout ────────────────────────────────────────────
if [[ ! -d "$GOOSE_SOURCE/ui/desktop/src" ]]; then
  red "✗ Expected $GOOSE_SOURCE/ui/desktop/src/ to exist."
  echo "  Is this really a Goose Desktop checkout?"
  exit 1
fi
green "✓ Goose Desktop layout verified"

# ─── 4. verify git + clean tree ───────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  red "✗ git not found in PATH."
  exit 1
fi
cd "$GOOSE_SOURCE"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  red "✗ Goose source tree has uncommitted changes."
  echo "  Commit or stash them first — this installer refuses to destroy work."
  exit 1
fi
green "✓ Git tree is clean"

# ─── 5. verify / warn on the pinned commit ───────────────────────────────────
PINNED=$(cat "$(dirname "${BASH_SOURCE[0]}")/patches/PINNED_COMMIT")
CURRENT=$(git rev-parse HEAD)
if [[ "$CURRENT" != "$PINNED" ]]; then
  yellow "⚠  Goose HEAD ($CURRENT) does not match the pinned commit ($PINNED)."
  echo "  The patches were generated against the pinned commit and may not apply."
  echo ""
  read -r -p "  Attempt anyway? [y/N] " yn
  case "$yn" in
    [Yy]*) echo "  Proceeding — patches will be validated before applying." ;;
    *) red "Installation aborted."; exit 1 ;;
  esac
else
  green "✓ Pinned commit matches ($CURRENT)"
fi

# ─── 6. create backup branch ──────────────────────────────────────────────────
BRANCH="goose-autonomous-sessions/$(date +%Y%m%d-%H%M%S)"
git checkout -b "$BRANCH" >/dev/null 2>&1
green "✓ Backup branch created: $BRANCH"

# ─── 7. validate patches before applying ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo ""
bold "─── validating patches ───"
if ! "$SCRIPT_DIR/patches/validate.sh" "$GOOSE_SOURCE" 2>&1; then
  red "✗ Patch validation failed. Aborting — no changes were applied to Goose source."
  git checkout - >/dev/null 2>&1
  git branch -D "$BRANCH" >/dev/null 2>&1
  exit 1
fi
green "✓ All patches validate cleanly"

# ─── 8. install the autonomous module + adapters ─────────────────────────────
MODULE_SRC="$SCRIPT_DIR/src/autonomous"
MODULE_DST="$GOOSE_SOURCE/ui/desktop/src/autonomous"
ADAPTER_SRC="$SCRIPT_DIR/adapters"
ADAPTER_DST="$GOOSE_SOURCE/ui/desktop/src/adapters"

if [[ -d "$MODULE_DST" ]]; then
  yellow "⚠  $MODULE_DST already exists — overwriting with the current version."
  rm -rf "$MODULE_DST"
fi
if [[ -d "$ADAPTER_DST" ]]; then
  yellow "⚠  $ADAPTER_DST already exists — overwriting with the current version."
  rm -rf "$ADAPTER_DST"
fi
mkdir -p "$MODULE_DST" "$ADAPTER_DST"
cp "$MODULE_SRC"/*.ts "$MODULE_DST/"
cp "$ADAPTER_SRC"/*.ts "$ADAPTER_DST/"
green "✓ Installed autonomous module → ui/desktop/src/autonomous/ ($(ls "$MODULE_DST" | wc -l) files)"
green "✓ Installed host adapters   → ui/desktop/src/adapters/   ($(ls "$ADAPTER_DST" | wc -l) files)"

# ─── 9. create the autonomous controller singleton ───────────────────────────
SINGLETON="$MODULE_DST/index.ts"
cat > "$SINGLETON" <<'TS'
// src/autonomous/index.ts — created by install.sh
//
// Wires the portable controller to Goose Desktop's Electron + ACP runtime.
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
export * from './contextMonitor';
export * from './completionDetector';
export * from './stateStore';
export * from './sessionManager';
export * from './navigation';
export * from './recovery';
export * from './logger';
TS
green "✓ Wired controller singleton (src/autonomous/index.ts)"

# ─── 10. apply the patches ────────────────────────────────────────────────────
echo ""
bold "─── applying patches ───"
while IFS= read -r patch; do
  [[ -z "$patch" || "$patch" =~ ^# ]] && continue
  PATCH_FILE="$SCRIPT_DIR/patches/$patch"
  if [[ ! -f "$PATCH_FILE" ]]; then
    red "✗ Missing patch file: $patch"
    exit 1
  fi
  if git apply --whitespace=fix "$PATCH_FILE"; then
    green "✓ Applied: $patch"
  else
    red "✗ Failed to apply: $patch"
    echo "  Goose source may have drifted from the pinned commit."
    echo "  Run:  git checkout .   to revert, then retry with the pinned commit."
    exit 1
  fi
done < "$SCRIPT_DIR/patches/SERIES"

# ─── 11. optionally build ─────────────────────────────────────────────────────
if [[ "$BUILD_DESKTOP" == "true" ]]; then
  echo ""
  bold "─── building Goose Desktop ───"
  cd "$GOOSE_SOURCE/ui/desktop"
  if ! command -v pnpm >/dev/null 2>&1; then
    yellow "⚠  pnpm not found — skipping build."
    echo "  Install pnpm (npm i -g pnpm) then run:  cd ui/desktop && pnpm install && pnpm build"
  else
    pnpm install 2>&1 | tail -3
    if pnpm build 2>&1 | tail -20; then
      green "✓ Goose Desktop built successfully"
    else
      red "✗ Build failed. See output above."
      echo "  Patches were applied but the build failed — you can inspect and fix manually."
      exit 1
    fi
  fi
fi

# ─── 12. summary ───────────────────────────────────────────────────────────────
echo ""
bold "─── installation summary ───"
echo "  Goose source:       $GOOSE_SOURCE"
echo "  Backup branch:      $BRANCH"
echo "  Pinned commit:      $PINNED"
echo "  Module installed:   ui/desktop/src/autonomous/ (12 files)"
echo "  Adapters installed: ui/desktop/src/adapters/ (3 files)"
echo "  Patches applied:    $(grep -v '^#' "$SCRIPT_DIR/patches/SERIES" | grep -v '^$' | wc -l)"
if [[ "$BUILD_DESKTOP" == "true" ]]; then
  echo "  Desktop built:      yes"
else
  echo "  Desktop built:      no (run with --build, or: cd ui/desktop && pnpm build)"
fi
echo ""
yellow "─── next steps ───"
echo "  1. Launch the customized Goose Desktop."
echo "  2. Open Settings → enable 'Autonomous Sessions'."
echo "  3. Set the rollover threshold (default 75%)."
echo "  4. Start a long-running task and walk away."
echo ""
echo "  To undo:  git checkout main && git branch -D $BRANCH"
echo "  Or run:   ./uninstall.sh $GOOSE_SOURCE"
echo ""
green "✓ Done."
