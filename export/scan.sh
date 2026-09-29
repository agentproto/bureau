#!/usr/bin/env bash
# Fail-closed export scan (TECH-PLAN D8). Usage: scan.sh [tree-dir] [report-file]
# Exit 0 only when there are zero findings. The report lists file:line:label (or a
# path rule) and never the matched text, so it cannot itself leak a secret. It is
# byte-identical across runs on the same tree (sorted, no timestamps).
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "$0")" && pwd)"
TREE="$(cd "${1:-$HERE/..}" && pwd)"
REPORT="${2:-}"
PATTERNS="$HERE/scan-patterns.txt"

list_files() {
  if [ -d "$TREE/.git" ]; then
    git -C "$TREE" ls-files -co --exclude-standard
  else
    (cd "$TREE" && find . \( -name node_modules -o -name dist -o -name .git \) -prune -o -type f -print | sed 's#^\./##')
  fi
}

# The scan's own definitions are excluded from content matching (they contain the
# literal patterns) but are still subject to the path denylist.
is_definition() {
  case "$1" in export/scan-patterns.txt|export/scan.sh|export/scan-selftest.sh) return 0 ;; *) return 1 ;; esac
}

path_finding() {
  local p="$1" base
  base="$(basename "$p")"
  case "/$p" in
    */out/*|*/publish/*|*/sessions/*|*camofox-profiles*) echo "$p:0:path-denylist"; return ;;
  esac
  case "$base" in
    *.har|*.webm|*.mp4|.env|.env.*) echo "$p:0:path-denylist"; return ;;
  esac
}

FINDINGS="$(mktemp)"
trap 'rm -f "$FINDINGS"' EXIT

while IFS= read -r f; do
  [ -f "$TREE/$f" ] || continue
  path_finding "$f" >> "$FINDINGS"
  is_definition "$f" && continue
  while IFS=$'\t' read -r label flags regex; do
    case "$label" in ''|'#'*) continue ;; esac
    opt="-nE"; [ "$flags" = "i" ] && opt="-nEi"
    grep -I $opt -e "$regex" "$TREE/$f" 2>/dev/null | cut -d: -f1 | sed "s#^#$f:#; s#\$#:$label#" >> "$FINDINGS" || true
  done < "$PATTERNS"
done < <(list_files | sort)

sort -u "$FINDINGS" > "$FINDINGS.sorted"
mv "$FINDINGS.sorted" "$FINDINGS"
COUNT="$(wc -l < "$FINDINGS" | tr -d ' ')"

emit() {
  echo "bureau export scan"
  echo "findings: $COUNT"
  cat "$FINDINGS"
}
if [ -n "$REPORT" ]; then emit > "$REPORT"; else emit; fi
[ "$COUNT" -eq 0 ]
