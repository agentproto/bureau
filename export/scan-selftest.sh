#!/usr/bin/env bash
# Proves scan.sh is fail-closed: a clean copy passes, a copy with a planted token
# (synthetic, built at runtime so this file holds no token literal) fails.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/clean" "$TMP/planted"
printf 'export const ok = 1\n' > "$TMP/clean/a.ts"
cp "$TMP/clean/a.ts" "$TMP/planted/a.ts"
printf 'const key = "%s%s"\n' "s" "k-planted0123456789abcdef" > "$TMP/planted/leak.ts"
"$HERE/scan.sh" "$TMP/clean" "$TMP/clean.report" || { echo "FAIL: clean tree rejected"; exit 1; }
if "$HERE/scan.sh" "$TMP/planted" "$TMP/planted.report"; then echo "FAIL: planted secret not caught"; exit 1; fi
grep -q 'leak.ts:1:token-sk' "$TMP/planted.report" || { echo "FAIL: finding not reported"; exit 1; }
grep -q 'planted0123' "$TMP/planted.report" && { echo "FAIL: report leaked the value"; exit 1; }
echo "scan selftest ok (clean passes, planted secret fails, report holds no value)"
