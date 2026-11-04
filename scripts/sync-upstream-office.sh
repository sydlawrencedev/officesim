#!/usr/bin/env bash
# Three-way merge pixel-agents' office engine (webview-ui/src/office) into src/office.
#
# Usage: scripts/sync-upstream-office.sh [base] [target]
#   base   upstream commit src/office was last synced to (default: "Synced to" in UPSTREAM.md)
#   target upstream commit to sync to (default: pixel-agents/main)
#
# Files we share with upstream are merged with `git merge-file --diff3`; conflicts are left
# in place with markers. Upstream-only files are listed, not copied: decide on each by hand.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url pixel-agents >/dev/null 2>&1; then
  git remote add pixel-agents https://github.com/pixel-agents-hq/pixel-agents
fi
git fetch -q pixel-agents

BASE="${1:-$(sed -n 's/^- Synced to: `\([0-9a-f]*\)`.*/\1/p' UPSTREAM.md)}"
TARGET="$(git rev-parse "${2:-pixel-agents/main}")"
UP=webview-ui/src/office
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Merging $UP ${BASE:0:7}..${TARGET:0:7} into src/office"

conflicts=()
# merge <ours> <upstream path>
merge() {
  local f="$1" up="$2"
  git cat-file -e "$TARGET:$up" 2>/dev/null || return 0
  if git cat-file -e "$BASE:$up" 2>/dev/null; then
    git show "$BASE:$up" > "$TMP/base"
  else
    : > "$TMP/base"
  fi
  git show "$TARGET:$up" > "$TMP/theirs"
  if ! git merge-file --diff3 -L ours -L base -L upstream "$f" "$TMP/base" "$TMP/theirs"; then
    conflicts+=("$f")
  fi
}

while IFS= read -r f; do
  merge "$f" "$UP/${f#src/office/}"
done < <(find src/office -type f | sort)
merge src/constants.ts webview-ui/src/constants.ts
merge src/core/paletteUtils.ts core/src/paletteUtils.ts

echo
echo "Upstream-only files (not copied):"
git ls-tree -r --name-only "$TARGET" -- "$UP" | while IFS= read -r p; do
  [ -e "src/office/${p#$UP/}" ] || echo "  ${p#$UP/}"
done

if [ ${#conflicts[@]} -gt 0 ]; then
  echo
  echo "Conflicts to resolve:"
  printf '  %s\n' "${conflicts[@]}"
fi

sed -i.bak "s/^- Synced to: \`[0-9a-f]*\`.*/- Synced to: \`${TARGET:0:7}\` ($(git log -1 --format='%ad, %s' --date=short "$TARGET"))/" UPSTREAM.md
rm -f UPSTREAM.md.bak
