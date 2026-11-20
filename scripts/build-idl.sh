#!/usr/bin/env bash
# Builds the program's IDL into programs/darkseek-vault/idl/darkseek_vault.json.
#   --check   build to a temporary file and fail if it differs from the committed IDL
set -euo pipefail
cd "$(dirname "$0")/.."
out=programs/darkseek-vault/idl/darkseek_vault.json
if [[ "${1:-}" == "--check" ]]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  cargo run --quiet --release --manifest-path tools/idl-build/Cargo.toml -- programs/darkseek-vault "$tmp"
  if ! diff -u "$out" "$tmp"; then
    echo "the committed IDL is out of date: run scripts/build-idl.sh" >&2
    exit 1
  fi
  echo "IDL is up to date"
else
  cargo run --quiet --release --manifest-path tools/idl-build/Cargo.toml -- programs/darkseek-vault "$out"
  echo "wrote $out"
fi
