#!/usr/bin/env bash
#
# goose-autonomous-sessions — uninstaller
#
# Removes the autonomous-session module from a Goose Desktop source checkout
# and restores the pre-installation state.
#
# Usage:
#   ./uninstall.sh /path/to/goose
#   GOOSE_SOURCE=/path/to/goose ./uninstall.sh
#
set -euo pipefail

GOOSE_SOURCE="${1:-${GOOSE_SOURCE:-}}"

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

echo ""
bold "goose-autonomous-sessions — uninstaller"
echo ""

if [[ -z "$GOOSE_SOURCE" ]]; then
  red "✗ Goose source path required."
  echo "  Usage:  ./uninstall.sh /path/to/goose"
  exit 1
fi
if [[ ! -d "$GOOSE_SOURCE" ]]; then
  red "✗ Goose source not found: $GOOSE_SOURCE"
  exit 1
fi

cd "$GOOSE_SOURCE"
MODULE_DST="ui/desktop/src/autonomous"
ADAPTER_DST="ui/desktop/src/adapters"

if [[ ! -d "$MODULE_DST" ]]; then
  yellow "⚠  $MODULE_DST does not exist — nothing to uninstall."
  exit 0
fi

# ─── find the backup branch ──────────────────────────────────────────────────
BACKUP_BRANCH=$(git branch --list 'goose-autonomous-sessions/*' --format='%(refname:short)' | head -1)

if [[ -n "$BACKUP_BRANCH" ]]; then
  green "✓ Found backup branch: $BACKUP_BRANCH"
  echo "  Restoring Goose source to pre-installation state..."

  # The backup branch was created from the original commit BEFORE patches were
  # applied. Check it out, revert the working tree to that commit's state,
  # then remove the untracked autonomous/ + adapters/ dirs.
  git checkout "$BACKUP_BRANCH" >/dev/null 2>&1
  # Revert any working-tree changes (the patches were applied to the working tree)
  git checkout -- . >/dev/null 2>&1 || true

  # Remove the untracked module + adapter dirs (install.sh copied these in)
  rm -rf "$MODULE_DST" "$ADAPTER_DST" 2>/dev/null || true

  green "✓ Restored Goose source to pre-installation state."
  echo ""
  bold "─── uninstall summary ───"
  echo "  Goose source:      $GOOSE_SOURCE"
  echo "  Restored from:    $BACKUP_BRANCH"
  echo "  Module removed:    $MODULE_DST"
  echo "  Adapters removed:  $ADAPTER_DST"
  echo "  Autonomous state: preserved (in app-data) — safe to inspect or delete manually."
  echo ""
  echo "  To delete the backup branch:  git branch -D $BACKUP_BRANCH"
else
  # no backup branch — just remove the module dir + revert tracked changes
  rm -rf "$MODULE_DST" "$ADAPTER_DST"
  green "✓ Removed $MODULE_DST + $ADAPTER_DST"
  # try to revert the patched tracked files
  git checkout -- ui/desktop/src/constants/events.ts \
                   ui/desktop/src/hooks/useChatSession.ts \
                   ui/desktop/src/hooks/useNavigationSessions.ts \
                   ui/desktop/src/main.ts \
                   ui/desktop/src/preload.ts \
                   ui/desktop/src/utils/settings.ts 2>/dev/null || true
  yellow "⚠  No backup branch found — the module dir was deleted and tracked files reverted."
  echo "  Review with:  git status"
fi

echo ""
green "✓ Done. Normal Goose usage is unaffected."
