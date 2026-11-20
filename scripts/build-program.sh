#!/usr/bin/env bash
# Builds the vault program: target/deploy/darkseek_vault.so.
# Release builds use solana-verify in a pinned image instead (see docs/releasing.md).
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build-sbf --manifest-path programs/darkseek-vault/Cargo.toml "$@"
sha256sum target/deploy/darkseek_vault.so
