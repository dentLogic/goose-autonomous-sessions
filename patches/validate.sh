#!/usr/bin/env bash
#
# patches/validate.sh — verify goose-autonomous-sessions v0.2 patches apply
# cleanly against the pinned Goose Desktop source.
#
# Usage:
#   ./validate.sh /path/to/goose               # validates a real Goose checkout
#   ./validate.sh                               # self-test against a temp checkout
#   GOOSE_SOURCE=/path/to/goose ./validate.sh
#
# Exit codes:
#   0  all patches apply cleanly
#   1  Goose source not found / wrong layout / HEAD != pinned commit
#   2  one or more patches failed `git apply --check`
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINNED_COMMIT="$(cat "$SCRIPT_DIR/PINNED_COMMIT")"
PATCHES=(
  0001-add-autonomous-event.patch
  0002-add-settings-field.patch
  0003-wire-useChatSession.patch
  0004-wire-navigation.patch
  0005-add-electron-ipc.patch
)

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
bold()    { printf "\033[1m%s\033[0m\n" "$1"; }

GOOSE_SOURCE="${1:-${GOOSE_SOURCE:-}}"

# ─── self-test mode: clone the pinned commit into a temp dir ─────────────────
if [[ -z "$GOOSE_SOURCE" ]]; then
  yellow "No GOOSE_SOURCE given — running self-test against the pinned commit."
  GOOSE_SOURCE="$(mktemp -d)/goose"
  echo "  Cloning aaif-goose/goose @ $PINNED_COMMIT (shallow)..."
  git clone --quiet --depth 1 "https://github.com/aaif-goose/goose" "$GOOSE_SOURCE" >/dev/null 2>&1 \
    || git clone --quiet "https://github.com/aaif-goose/goose" "$GOOSE_SOURCE"
  ( cd "$GOOSE_SOURCE" && git fetch --quiet origin "$PINNED_COMMIT" >/dev/null 2>&1 \
      && git checkout --quiet "$PINNED_COMMIT" )
  SELF_TEST=1
else
  SELF_TEST=0
fi

if [[ ! -d "$GOOSE_SOURCE" ]]; then
  red "✗ Goose source not found: $GOOSE_SOURCE"
  exit 1
fi

if [[ ! -d "$GOOSE_SOURCE/ui/desktop/src" ]]; then
  red "✗ $GOOSE_SOURCE/ui/desktop/src/ not found — not a Goose Desktop checkout."
  exit 1
fi

# ─── 1. verify HEAD matches the pinned commit ────────────────────────────────
HEAD_SHA="$(git -C "$GOOSE_SOURCE" rev-parse HEAD 2>/dev/null || echo "")"
if [[ -z "$HEAD_SHA" ]]; then
  red "✗ $GOOSE_SOURCE is not a git repo."
  exit 1
fi
PINNED_FULL="$(git -C "$GOOSE_SOURCE" rev-parse "$PINNED_COMMIT" 2>/dev/null || echo "$PINNED_COMMIT")"
if [[ "$HEAD_SHA" != "$PINNED_FULL" ]]; then
  red "✗ HEAD ($HEAD_SHA) does not match pinned commit ($PINNED_FULL)."
  echo "  Run: cd $GOOSE_SOURCE && git checkout $PINNED_COMMIT"
  exit 1
fi
green "✓ HEAD matches pinned commit $PINNED_COMMIT"

# ─── 2. verify the tree is clean (so we can detect already-applied patches) ──
if [[ -n "$(git -C "$GOOSE_SOURCE" status --porcelain 2>/dev/null)" ]]; then
  yellow "⚠  Goose tree has uncommitted changes — `git apply --check` may report false failures."
fi

# ─── 3. for each patch: git apply --check (dry-run) ──────────────────────────
bold "─── patch validation ───"
failures=0
for p in "${PATCHES[@]}"; do
  patch_path="$SCRIPT_DIR/$p"
  if [[ ! -f "$patch_path" ]]; then
    red "✗ MISSING: $p"
    failures=$((failures + 1))
    continue
  fi
  if git -C "$GOOSE_SOURCE" apply --check --verbose "$patch_path" 2>&1 | sed 's/^/    /'; then
    green "  PASS: $p"
  else
    red "  FAIL: $p"
    failures=$((failures + 1))
  fi
done

echo
bold "─── summary ───"
echo "  Pinned commit: $PINNED_COMMIT"
echo "  Goose source:  $GOOSE_SOURCE"
echo "  Patches tested: ${#PATCHES[@]}"
echo "  Failures:       $failures"

if [[ "${SELF_TEST:-0}" == "1" ]]; then
  echo "  (self-test mode — temp checkout will be left at $GOOSE_SOURCE for inspection)"
fi

if [[ "$failures" -gt 0 ]]; then
  red "✗ Validation FAILED — $failures patch(es) did not apply cleanly."
  exit 2
fi

green "✓ All ${#PATCHES[@]} patches apply cleanly against the pinned Goose source."
exit 0
