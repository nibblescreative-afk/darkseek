#!/usr/bin/env bash
# Starts a local validator with the vault program deployed as upgradeable, at
# the id the source declares (a devnet demo placeholder; nothing is deployed there).
#   scripts/localnet.sh <upgrade authority pubkey or keypair file> [rpc port, default 8899]
# Then: npx tsx scripts/setup-cluster.ts --rpc http://127.0.0.1:8899 --admin <keypair> --create-test-usdc ...
set -euo pipefail
cd "$(dirname "$0")/.."
authority=${1:?usage: scripts/localnet.sh <upgrade authority> [rpc port]}
port=${2:-8899}
[[ -f target/deploy/darkseek_vault.so ]] || scripts/build-program.sh
exec solana-test-validator --reset --ledger "${LEDGER:-test-ledger}" --bind-address 127.0.0.1 \
  --rpc-port "$port" --faucet-port $((port + 2)) \
  --upgradeable-program 4jNw2nbMz3ZHAH3dWcUrUbS78mfKPNqF1Bbq1x1vVJQt target/deploy/darkseek_vault.so "$authority"
