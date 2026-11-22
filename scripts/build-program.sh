#!/usr/bin/env bash
# Builds the vault program as SBPF v3: target/deploy/darkseek_vault.so.
#
#   scripts/build-program.sh                 cargo build-sbf with the local Agave toolchain
#   scripts/build-program.sh --verifiable    solana-verify build in the pinned image, the way
#                                            releases are built (docs/releasing.md); needs Docker
#
# Further arguments go to cargo build-sbf or to solana-verify build. Either way
# the build fails unless the program is SBPF v3.
set -euo pipefail
cd "$(dirname "$0")/.."

# Releases are built in this image, pinned by digest (docs/verify.md shows it too).
# Its cargo build-sbf 4.3.0 builds SBPF v0 unless told otherwise, so the version
# is always passed.
VERIFY_IMAGE=solanafoundation/solana-verifiable-build:4.3.0@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
SBPF_ARCH=v3

if [[ ${1:-} == --verifiable ]]; then
  shift
  echo "solana-verify build --arch $SBPF_ARCH in $VERIFY_IMAGE"
  solana-verify build --library-name darkseek_vault --base-image "$VERIFY_IMAGE" --arch "$SBPF_ARCH" "$@"
else
  cargo build-sbf --manifest-path programs/darkseek-vault/Cargo.toml --arch "$SBPF_ARCH" "$@"
fi

so=target/deploy/darkseek_vault.so
scripts/sbpf-version.sh --expect "$SBPF_ARCH" "$so"
sha256sum "$so"
