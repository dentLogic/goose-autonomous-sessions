#!/usr/bin/env bash
#
# goose-autonomous-sessions — installer (v0.1)
#
# Installs the portable autonomous-session module into a local Goose Desktop
# source checkout. Safe by design: validates Linux + Goose source layout +
# clean git tree before touching anything, creates a backup branch, and prints
# exactly what changed.
#
# Usage:
#   ./install.sh /path/to/goose
#   GOOSE_SOURCE=/path/to/goose ./install.sh
#
# What this installer does (v0.1):
#   ✓ Verifies Linux
#   ✓ Verifies the Goose source layout (ui/desktop/src/ exists)
#   ✓ Verifies the git tree is clean
#   ✓ Creates a backup branch: goose-autonomous-sessions/<timestamp>
#   ✓ Copies src/autonomous/ → ui/desktop/src/autonomous/
#   ✓ Prints a clear summary + next steps
#
# What is intentionally deferred (v0.2+, pending a pinned Goose commit):
#   - Applying the small lifecycle hooks in useChatSession.ts / navigation /
#     settings (see patches/README.md)
#   - Building the customized Desktop app
#
set -euo pipefail

GOOSE_SOURCE="${1:-${GOOSE_SOURCE:-}}"

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

echo ""
bold "goose-autonomous-sessions — installer (v0.1)"
echo ""

# ─── 1. verify Linux ──────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  red "✗ Linux required (got $(uname -s))."
  echo "  macOS/Windows support is not in scope for v0.1."
  exit 1
fi
green "✓ Linux"

# ─── 2. locate Goose source ───────────────────────────────────────────────────
if [[ -z "$GOOSE_SOURCE" ]]; then
  red "✗ Goose source path required."
  echo "  Usage:  ./install.sh /path/to/goose"
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
green "✓ Goose Desktop layout verified (ui/desktop/src/ exists)"

# ─── 4. verify git is available + tree is clean ───────────────────────────────
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

# ─── 5. create backup branch ──────────────────────────────────────────────────
BRANCH="goose-autonomous-sessions/$(date +%Y%m%d-%H%M%S)"
git checkout -b "$BRANCH" >/dev/null 2>&1
green "✓ Backup branch created: $BRANCH"

# ─── 6. install the autonomous module ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_SRC="$SCRIPT_DIR/src/autonomous"
MODULE_DST="$GOOSE_SOURCE/ui/desktop/src/autonomous"

if [[ -d "$MODULE_DST" ]]; then
  yellow "⚠  $MODULE_DST already exists — overwriting with the current version."
  rm -rf "$MODULE_DST"
fi
mkdir -p "$MODULE_DST"
cp "$MODULE_SRC"/*.ts "$MODULE_DST/"
green "✓ Installed autonomous module → ui/desktop/src/autonomous/"
ls "$MODULE_DST" | sed 's/^/    /'

# ─── 7. summary ───────────────────────────────────────────────────────────────
echo ""
bold "─── installation summary ───"
echo "  Goose source:     $GOOSE_SOURCE"
echo "  Backup branch:    $BRANCH"
echo "  Module installed: ui/desktop/src/autonomous/ (12 files)"
echo ""
yellow "─── next steps (manual, v0.2 will automate these) ───"
echo "  1. Wire the controller into your Desktop lifecycle hooks"
echo "     (see patches/README.md for the exact integration points)."
echo "  2. Provide a StateStoreAdapter + LoggerAdapter backed by the"
echo "     Electron main process (app.getPath('userData'))."
echo "  3. Provide generateHandoffResponse + sendPrompt that call ACP."
echo "  4. Build the customized Desktop:  cd ui/desktop && pnpm build"
echo ""
echo "  To undo:  git checkout main && git branch -D $BRANCH"
echo "  Or run:   ./uninstall.sh $GOOSE_SOURCE"
echo ""
green "✓ Done."
