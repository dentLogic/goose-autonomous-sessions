#!/usr/bin/env bash
#
# find-goose.sh — locate the Goose Desktop source checkout and offer to install.
#
# Run with:  bash find-goose.sh
#
# Searches common locations for a Goose source tree, prints the path if found,
# checks if it's at the pinned commit + has a clean git tree, then offers to
# run install.sh automatically.
#
# Usage:
#   bash find-goose.sh                    # search + offer to install
#   bash find-goose.sh /custom/search/dir # also search a custom directory
#   bash find-goose.sh --install          # search + install without asking
#   bash find-goose.sh --build            # search + install + build without asking
#
set -euo pipefail

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

AUTO_INSTALL=false
AUTO_BUILD=false
CUSTOM_DIR=""

for arg in "$@"; do
  case "$arg" in
    --install) AUTO_INSTALL=true ;;
    --build)   AUTO_INSTALL=true; AUTO_BUILD=true ;;
    *)         CUSTOM_DIR="$arg" ;;
  esac
done

# A directory qualifies as a Goose source checkout if it contains
# ui/desktop/src/ with main.ts — that's the tree install.sh patches.
is_goose_source() {
  local dir="$1"
  [[ -d "$dir/ui/desktop/src" ]] && [[ -f "$dir/ui/desktop/src/main.ts" ]]
}

echo ""
bold "🔍 Searching for Goose Desktop source..."
echo ""

# ─── Build the search list ────────────────────────────────────────────────────

SEARCH_DIRS=()
HOME_DIR="${HOME:-/root}"

if [[ -n "$CUSTOM_DIR" ]]; then
  SEARCH_DIRS+=("$CUSTOM_DIR")
fi

SEARCH_DIRS+=(
  "$HOME_DIR"
  "$HOME_DIR/goose"
  "$HOME_DIR/projects/goose"
  "$HOME_DIR/src/goose"
  "$HOME_DIR/code/goose"
  "$HOME_DIR/dev/goose"
  "$HOME_DIR/repos/goose"
  "$HOME_DIR/workspace/goose"
  "$HOME_DIR/Documents/goose"
  "$HOME_DIR/Desktop/goose"
  "/tmp/goose"
  "/opt/goose"
  "/srv/goose"
)

PARENT_DIRS=(
  "$HOME_DIR"
  "$HOME_DIR/projects"
  "$HOME_DIR/src"
  "$HOME_DIR/code"
  "$HOME_DIR/dev"
  "$HOME_DIR/repos"
  "$HOME_DIR/workspace"
  "/tmp"
  "/opt"
)

# ─── Search ───────────────────────────────────────────────────────────────────

FOUND_DIRS=()

for dir in "${SEARCH_DIRS[@]}"; do
  if [[ -d "$dir" ]] && is_goose_source "$dir"; then
    FOUND_DIRS+=("$dir")
  fi
done

for parent in "${PARENT_DIRS[@]}"; do
  [[ -d "$parent" ]] || continue
  for child in "$parent"/*/ ; do
    [[ -d "$child" ]] || continue
    already_found=false
    for f in "${FOUND_DIRS[@]:-}"; do
      [[ "$f" == "${child%/}" ]] && already_found=true && break
    done
    $already_found && continue
    if is_goose_source "$child"; then
      FOUND_DIRS+=("${child%/}")
    fi
  done
done

# Deduplicate
if [[ ${#FOUND_DIRS[@]} -gt 0 ]]; then
  UNIQUE_DIRS=($(printf '%s\n' "${FOUND_DIRS[@]}" | sort -u))
else
  UNIQUE_DIRS=()
fi

PINNED="ce0c4900837a51b2ae50ce0df1484c34a1be754e"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Not found ─────────────────────────────────────────────────────────────────

if [[ ${#UNIQUE_DIRS[@]} -eq 0 ]]; then
  red "✗ No Goose Desktop source checkout found."
  echo ""
  echo "  Searched: \$HOME, common project dirs, /tmp, /opt"
  [[ -n "$CUSTOM_DIR" ]] && echo "  Custom: $CUSTOM_DIR"
  echo ""
  bold "  Clone Goose at the pinned commit:"
  echo ""
  echo "    git clone https://github.com/aaif-goose/goose.git ~/goose"
  echo "    cd ~/goose"
  echo "    git checkout $PINNED"
  echo ""
  bold "  Then re-run this script:"
  echo "    bash find-goose.sh"
  echo ""
  exit 1
fi

# ─── Found exactly one ────────────────────────────────────────────────────────

if [[ ${#UNIQUE_DIRS[@]} -eq 1 ]]; then
  DIR="${UNIQUE_DIRS[0]}"
  green "✓ Found Goose Desktop source:"
  bold "  $DIR"
  echo ""

  READY=true

  # Check pinned commit
  if [[ -d "$DIR/.git" ]]; then
    HEAD=$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
    if [[ "$HEAD" == "$PINNED" ]]; then
      green "  ✓ At the pinned commit"
    else
      yellow "  ⚠  HEAD is ${HEAD:0:12} (pinned: ${PINNED:0:12})"
      echo "     The installer will warn you. To check out the pinned commit:"
      echo "       cd $DIR && git checkout $PINNED"
      READY=false
    fi
  fi

  # Check clean tree
  if [[ -d "$DIR/.git" ]]; then
    if [[ -z "$(git -C "$DIR" status --porcelain 2>/dev/null)" ]]; then
      green "  ✓ Git tree is clean"
    else
      yellow "  ⚠  Git tree has uncommitted changes — commit or stash first"
      READY=false
    fi
  fi
  echo ""

  # Offer to install
  if $AUTO_INSTALL; then
    if $READY; then
      green "  Installing..."
      exec bash "$SCRIPT_DIR/install.sh" "$DIR" $($AUTO_BUILD && echo "--build")
    else
      red "  ✗ Not ready to install (see warnings above). Fix and re-run."
      exit 1
    fi
  else
    bold "  Run install:"
    echo "    ./install.sh $DIR"
    echo ""
    bold "  Run install + build:"
    echo "    ./install.sh $DIR --build"
    echo ""
    bold "  Or let this script do it:"
    echo "    bash find-goose.sh --install    # install"
    echo "    bash find-goose.sh --build      # install + build"
    echo ""
    bold "  To uninstall later:"
    echo "    ./uninstall.sh $DIR"
    echo ""
    read -r -p "  Install now? [Y/n] " yn
    case "$yn" in
      [Nn]*) echo "  Skipped."; exit 0 ;;
    esac
    if $READY; then
      read -r -p "  Also build the Desktop? [y/N] " build_yn
      case "$build_yn" in
        [Yy]) exec bash "$SCRIPT_DIR/install.sh" "$DIR" --build ;;
        *)   exec bash "$SCRIPT_DIR/install.sh" "$DIR" ;;
      esac
    else
      red "  ✗ Not ready to install (see warnings above). Fix and re-run."
      exit 1
    fi
  fi
fi

# ─── Found multiple ────────────────────────────────────────────────────────────

if [[ ${#UNIQUE_DIRS[@]} -gt 1 ]]; then
  green "✓ Found ${#UNIQUE_DIRS[@]} Goose Desktop source checkouts:"
  echo ""
  i=1
  for dir in "${UNIQUE_DIRS[@]}"; do
    HEAD=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo "?")
    clean=""
    [[ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ]] && clean=" ✓ clean" || clean=" ⚠ dirty"
    pinned=""
    [[ "$HEAD" == "${PINNED:0:12}" ]] && pinned=" ✓ pinned" || pinned=""
    echo "  [$i] $dir  (HEAD: $HEAD$clean$pinned)"
    i=$((i + 1))
  done
  echo ""
  bold "  Pick one to install:"
  echo "    ./install.sh <path>"
  echo ""
  if ! $AUTO_INSTALL; then
    read -r -p "  Install which? [1-$((i-1))] or Enter to skip: " choice
    if [[ -n "$choice" && "$choice" -ge 1 && "$choice" -le $((i-1)) ]]; then
      DIR="${UNIQUE_DIRS[$((choice - 1))]}"
      echo ""
      read -r -p "  Also build? [y/N] " build_yn
      case "$build_yn" in
        [Yy]) exec bash "$SCRIPT_DIR/install.sh" "$DIR" --build ;;
        *)   exec bash "$SCRIPT_DIR/install.sh" "$DIR" ;;
      esac
    fi
  fi
  echo ""
fi
