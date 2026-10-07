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

if [[ ! -d "$MODULE_DST" ]]; then
  yellow "⚠  $MODULE_DST does not exist — nothing to uninstall."
  exit 0
fi

# ─── find the backup branch ──────────────────────────────────────────────────
BACKUP_BRANCH=$(git branch --list 'goose-autonomous-sessions/*' --format='%(refname:short)' | head -1)

if [[ -n "$BACKUP_BRANCH" ]]; then
  green "✓ Found backup branch: $BACKUP_BRANCH"
  echo "  Restoring Goose source to pre-installation state..."
  CURRENT=$(git branch --show-current)
  git checkout "$BACKUP_BRANCH" >/dev/null 2>&1
  if [[ "$CURRENT" != "main" && "$CURRENT" != "master" ]]; then
    # we were on the install branch; switch back to main/master after restoring
    git checkout main >/dev/null 2>&1 || git checkout master >/dev/null 2>&1 || true
  fi
  green "✓ Restored."
  echo ""
  bold "─── uninstall summary ───"
  echo "  Goose source:      $GOOSE_SOURCE"
  echo "  Restored from:    $BACKUP_BRANCH"
  echo "  Autonomous state: preserved (in app-data) — safe to inspect or delete manually."
  echo ""
  echo "  To delete the backup branch:  git branch -D $BACKUP_BRANCH"
else
  # no backup branch — just remove the module dir
  rm -rf "$MODULE_DST"
  green "✓ Removed $MODULE_DST"
  yellow "⚠  No backup branch found — the module dir was deleted but the git tree"
  echo "  may still have other changes from manual wiring. Review with:  git diff"
fi

echo ""
green "✓ Done. Normal Goose usage is unaffected."
