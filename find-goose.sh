#!/usr/bin/env bash
#
# find-goose.sh — locate the Goose Desktop source checkout on your machine.
#
# Run with:  bash find-goose.sh
#
# Searches common locations for a Goose source tree and prints the path
# if found. If multiple are found, prints all of them.
#
# Usage:
#   bash find-goose.sh                    # search common locations
#   bash find-goose.sh /custom/search/dir # also search a custom directory
#
set -euo pipefail

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

# A directory qualifies as a "Goose source checkout" if it contains
# ui/desktop/src/ — that's the tree our install.sh patches.
is_goose_source() {
  local dir="$1"
  [[ -d "$dir/ui/desktop/src" ]] && [[ -f "$dir/ui/desktop/src/main.ts" ]]
}

# Also check if it has the goose Rust crates (stronger signal)
is_goose_source_strong() {
  local dir="$1"
  is_goose_source "$dir" && [[ -d "$dir/crates/goose" ]]
}

echo ""
bold "🔍 Searching for Goose Desktop source..."
echo ""

# ─── Build the search list ────────────────────────────────────────────────────

SEARCH_DIRS=()

# 1. Explicit custom dir (if passed as arg)
if [[ -n "${1:-}" ]]; then
  SEARCH_DIRS+=("$1")
fi

# 2. Common clone locations
HOME_DIR="${HOME:-/root}"
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

# 3. Common parent dirs (we'll scan one level deep)
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

# Scan parent dirs one level deep
for parent in "${PARENT_DIRS[@]}"; do
  [[ -d "$parent" ]] || continue
  for child in "$parent"/*/ ; do
    [[ -d "$child" ]] || continue
    # Skip if we already found it
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

# ─── Report ───────────────────────────────────────────────────────────────────

if [[ ${#UNIQUE_DIRS[@]} -eq 0 ]]; then
  red "✗ No Goose Desktop source checkout found."
  echo ""
  echo "  Searched:"
  echo "    \$HOME and common project dirs"
  echo "    /tmp, /opt"
  [[ -n "${1:-}" ]] && echo "    Custom: $1"
  echo ""
  yellow "  Goose source not found. Clone it first:"
  echo ""
  echo "    git clone https://github.com/aaif-goose/goose.git ~/goose"
  echo "    cd ~/goose"
  echo "    git checkout ce0c4900837a51b2ae50ce0df1484c34a1be754e"
  echo ""
  echo "  Then run:"
  echo "    ./install.sh ~/goose"
  echo ""
  exit 1
fi

if [[ ${#UNIQUE_DIRS[@]} -eq 1 ]]; then
  DIR="${UNIQUE_DIRS[0]}"
  green "✓ Found Goose Desktop source:"
  bold "  $DIR"
  echo ""

  # Check if it's at the pinned commit
  if [[ -d "$DIR/.git" ]]; then
    HEAD=$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
    PINNED="ce0c4900837a51b2ae50ce0df1484c34a1be754e"
    if [[ "$HEAD" == "$PINNED" ]]; then
      green "  ✓ At the pinned commit: $HEAD"
    else
      yellow "  ⚠  HEAD is $HEAD"
      yellow "     Pinned commit is $PINNED"
      echo "     The installer will warn you. To check out the pinned commit:"
      echo "       cd $DIR && git checkout $PINNED"
    fi
  fi
  echo ""

  # Check if the tree is clean
  if [[ -d "$DIR/.git" ]]; then
    if [[ -z "$(git -C "$DIR" status --porcelain 2>/dev/null)" ]]; then
      green "  ✓ Git tree is clean (ready to install)"
    else
      yellow "  ⚠  Git tree has uncommitted changes."
      echo "     Commit or stash them before installing."
    fi
  fi
  echo ""

  bold "  To install:"
  echo "    ./install.sh $DIR"
  echo ""
  bold "  To install + build:"
  echo "    ./install.sh $DIR --build"
  echo ""
  bold "  To uninstall:"
  echo "    ./uninstall.sh $DIR"
  echo ""
else
  green "✓ Found ${#UNIQUE_DIRS[@]} Goose Desktop source checkouts:"
  echo ""
  for dir in "${UNIQUE_DIRS[@]}"; do
    strong=""
    is_goose_source_strong "$dir" && strong=" (full source with crates/)"
    echo "  $dir$strong"
    if [[ -d "$dir/.git" ]]; then
      HEAD=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo "?")
      echo "    HEAD: $HEAD"
    fi
  done
  echo ""
  yellow "  Multiple found — pick one and run:"
  echo "    ./install.sh <chosen-path>"
  echo ""
fi
