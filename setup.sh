#!/usr/bin/env bash
#
# setup.sh — clone Goose source, install autonomous sessions, and build.
#
# This is the all-in-one script: it clones the Goose source code at the
# pinned commit, runs install.sh, and builds the customized Desktop.
#
# Usage:
#   bash setup.sh                    # clone to ~/goose, install, build
#   bash setup.sh /path/to/clone    # clone to a custom path
#   bash setup.sh --no-build         # clone + install without building
#
set -euo pipefail

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

PINNED="ce0c4900837a51b2ae50ce0df1484c34a1be754e"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLONE_DIR="$HOME/goose"
DO_BUILD=true

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=false ;;
    *)          CLONE_DIR="$arg" ;;
  esac
done

echo ""
bold "🪿 goose-autonomous-sessions — full setup"
echo "   clone → install → build"
echo ""

# ─── 1. Check prerequisites ────────────────────────────────────────────────────

bold "─── Step 1: Checking prerequisites ───"
echo ""

if [[ "$(uname -s)" != "Linux" ]]; then
  red "✗ Linux required (got $(uname -s))."
  exit 1
fi
green "✓ Linux"

if ! command -v git >/dev/null 2>&1; then
  red "✗ git not found. Install it:  sudo apt install git"
  exit 1
fi
green "✓ git: $(git --version)"

if ! command -v bun >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  red "✗ Neither bun nor node found."
  echo "  Install bun:  curl -fsSL https://bun.sh/install | bash"
  echo "  Or install node:  https://nodejs.org/"
  exit 1
fi
command -v bun >/dev/null 2>&1 && green "✓ bun: $(bun --version)" || green "✓ node: $(node --version)"

# pnpm is needed for building Goose Desktop
if $DO_BUILD; then
  if ! command -v pnpm >/dev/null 2>&1; then
    yellow "⚠  pnpm not found (needed to build Goose Desktop)."
    echo "  Install it:  npm install -g pnpm"
    echo "  Then re-run this script."
    echo ""
    echo "  Alternatively, skip the build for now:"
    echo "    bash setup.sh --no-build"
    echo ""
    exit 1
  fi
  green "✓ pnpm: $(pnpm --version)"

  if ! command -v cargo >/dev/null 2>&1; then
    yellow "⚠  cargo (Rust) not found (needed to build Goose's native crates)."
    echo "  Install it:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo "  Then re-run this script."
    echo ""
    echo "  Alternatively, skip the build for now:"
    echo "    bash setup.sh --no-build"
    echo ""
    exit 1
  fi
  green "✓ cargo: $(cargo --version)"
fi

echo ""

# ─── 2. Clone Goose source ────────────────────────────────────────────────────

bold "─── Step 2: Cloning Goose source code ───"
echo ""

if [[ -d "$CLONE_DIR/.git" ]]; then
  yellow "⚠  $CLONE_DIR already exists."
  HEAD=$(git -C "$CLONE_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
  if [[ "$HEAD" == "$PINNED" ]]; then
    green "  Already at the pinned commit — skipping clone."
  else
    echo "  Current HEAD: ${HEAD:0:12}"
    echo "  Checking out pinned commit: ${PINNED:0:12}..."
    git -C "$CLONE_DIR" fetch origin 2>/dev/null || true
    git -C "$CLONE_DIR" checkout "$PINNED" 2>&1 | tail -1
    green "✓ Checked out pinned commit"
  fi
else
  echo "  Cloning to: $CLONE_DIR"
  git clone --depth 1 https://github.com/aaif-goose/goose.git "$CLONE_DIR" 2>&1 | tail -1
  git -C "$CLONE_DIR" fetch --depth 1 origin "$PINNED" 2>&1 | tail -1
  git -C "$CLONE_DIR" checkout "$PINNED" 2>&1 | tail -1
  green "✓ Cloned Goose source to: $CLONE_DIR"
fi

# Verify
if [[ ! -f "$CLONE_DIR/ui/desktop/src/main.ts" ]]; then
  red "✗ Clone failed — ui/desktop/src/main.ts not found in $CLONE_DIR"
  exit 1
fi
green "✓ Goose source verified (ui/desktop/src/main.ts exists)"
echo ""

# ─── 3. Run install.sh ────────────────────────────────────────────────────────

bold "─── Step 3: Installing autonomous sessions ───"
echo ""

if $DO_BUILD; then
  bash "$SCRIPT_DIR/install.sh" "$CLONE_DIR" --build
else
  bash "$SCRIPT_DIR/install.sh" "$CLONE_DIR"
fi

echo ""

# ─── 4. Done ──────────────────────────────────────────────────────────────────

bold "─── Done! ───"
echo ""
green "✓ Goose source:     $CLONE_DIR"
green "✓ Autonomous module: $CLONE_DIR/ui/desktop/src/autonomous/"
green "✓ Adapters:         $CLONE_DIR/ui/desktop/src/adapters/"
green "✓ Patches applied:  5"

if $DO_BUILD; then
  green "✓ Desktop built:    yes"
  echo ""
  bold "Next steps:"
  echo "  1. Launch the customized Goose Desktop:"
  echo "     cd $CLONE_DIR/ui/desktop"
  echo "     pnpm start    # or: electron ."
  echo ""
  echo "  2. Open Settings → enable 'Autonomous Sessions'"
  echo "  3. Set the rollover threshold (default 75%)"
  echo "  4. Start a long-running task and walk away"
else
  yellow "⚠  Desktop NOT built yet. To build later:"
  echo "     cd $CLONE_DIR/ui/desktop"
  echo "     pnpm install"
  echo "     pnpm build"
fi

echo ""
bold "To uninstall:"
echo "  $SCRIPT_DIR/uninstall.sh $CLONE_DIR"
echo ""
