#!/usr/bin/env bash
#
# find-goose.sh — locate the Goose Desktop SOURCE CODE and offer to install.
#
# IMPORTANT: This script looks for Goose SOURCE CODE (a git clone), NOT the
# Goose Desktop app you may have installed. The install.sh patches files in
# ui/desktop/src/ — those files only exist in the source repository.
#
# If you installed Goose as an app (downloaded .deb, .AppImage, or built it),
# you still need to clone the source code separately:
#
#   git clone https://github.com/aaif-goose/goose.git ~/goose
#   cd ~/goose
#   git checkout ce0c4900837a51b2ae50ce0df1484c34a1be754e
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

# A directory qualifies as Goose SOURCE CODE if it contains
# ui/desktop/src/main.ts — that's what install.sh patches.
is_goose_source() {
  local dir="$1"
  [[ -d "$dir/ui/desktop/src" ]] && [[ -f "$dir/ui/desktop/src/main.ts" ]]
}

# Check if Goose was installed as an APP (binary) — not source code
detect_goose_app() {
  local found=""
  # Check PATH
  if command -v goose >/dev/null 2>&1; then
    found=$(command -v goose)
  fi
  # Check common binary locations
  for p in \
    /usr/local/bin/goose \
    /usr/bin/goose \
    "$HOME/.local/bin/goose" \
    /opt/Goose/goose \
    /opt/goose/bin/goose \
    "$HOME/Applications/Goose" \
    "$HOME/.config/Goose"
  do
    if [[ -e "$p" ]]; then
      found="$p"
      break
    fi
  done
  echo "$found"
}

echo ""
bold "🔍 Searching for Goose Desktop SOURCE CODE..."
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

# ─── Not found — check if the Goose APP is installed ─────────────────────────

if [[ ${#UNIQUE_DIRS[@]} -eq 0 ]]; then
  red "✗ Goose Desktop SOURCE CODE not found."
  echo ""

  # Check if the Goose app (binary) is installed
  GOOSE_APP=$(detect_goose_app)
  if [[ -n "$GOOSE_APP" ]]; then
    yellow "  You have Goose installed as an app at: $GOOSE_APP"
    echo ""
    red "  But install.sh needs the Goose SOURCE CODE (the git repository),"
    red "  not the installed app. The patches modify files in ui/desktop/src/"
    red "  which only exist in the source."
    echo ""
  else
    echo "  Searched: \$HOME, common project dirs, /tmp, /opt"
    [[ -n "$CUSTOM_DIR" ]] && echo "  Custom: $CUSTOM_DIR"
    echo ""
  fi

  bold "  You need to clone the Goose SOURCE CODE:"
  echo ""
  echo "    git clone https://github.com/aaif-goose/goose.git ~/goose"
  echo "    cd ~/goose"
  echo "    git checkout $PINNED"
  echo ""
  bold "  Then re-run this script:"
  echo "    bash find-goose.sh"
  echo ""
  bold "  Or pass the path directly to install.sh:"
  echo "    ./install.sh ~/goose"
  echo ""
  echo "  ─────────────────────────────────────────────────────────"
  echo "  WHY does install.sh need source code?"
  echo "  ─────────────────────────────────────────────────────────"
  echo "  install.sh patches 6 files inside Goose's source tree:"
  echo "    ui/desktop/src/constants/events.ts"
  echo "    ui/desktop/src/hooks/useChatSession.ts"
  echo "    ui/desktop/src/hooks/useNavigationSessions.ts"
  echo "    ui/desktop/src/main.ts"
  echo "    ui/desktop/src/preload.ts"
  echo "    ui/desktop/src/utils/settings.ts"
  echo ""
  echo "  These files don't exist in a pre-built Goose app."
  echo "  You must have the source repository cloned to disk."
  echo ""
  exit 1
fi

# ─── Found exactly one ────────────────────────────────────────────────────────

if [[ ${#UNIQUE_DIRS[@]} -eq 1 ]]; then
  DIR="${UNIQUE_DIRS[0]}"
  green "✓ Found Goose Desktop source code:"
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
