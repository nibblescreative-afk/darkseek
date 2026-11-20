#!/usr/bin/env bash
# House style for prose: no em or en dashes anywhere in tracked text.
set -uo pipefail
cd "$(dirname "$0")/.."
if git grep -nIP '[\x{2013}\x{2014}]' -- . ':!package-lock.json' ':!**/Cargo.lock'; then
  echo "check-docs: replace the em or en dashes above (use a colon, a comma or two sentences)" >&2
  exit 1
fi
echo "check-docs: clean"
