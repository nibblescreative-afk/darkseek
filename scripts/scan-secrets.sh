#!/usr/bin/env bash
# Fails if anything that looks like a secret is tracked: keypair arrays,
# base58 secret keys, private key blocks, seed phrases, .env files, API tokens.
#   scripts/scan-secrets.sh            the files in the working tree that git tracks
#   scripts/scan-secrets.sh --history  every commit reachable from any ref
set -uo pipefail
cd "$(dirname "$0")/.."

patterns=(
  # a Solana keypair file: a JSON array of 64 bytes
  '\[[[:space:]]*([0-9]{1,3}[[:space:]]*,[[:space:]]*){63}[0-9]{1,3}[[:space:]]*\]'
  # a 64 byte secret key in base58 (87 or 88 characters)
  '(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{87,88}([^1-9A-HJ-NP-Za-km-z]|$)'
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  # seed phrases written into code or config
  '(mnemonic|seed[_ ]?phrase|secret[_ ]?phrase)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][a-z]+( [a-z]+){11,}'
  # values assigned to secret looking variables
  '(PRIVATE_KEY|SECRET_KEY|AUTHORITY_KEY|API_KEY|RPC_KEY)[[:space:]]*=[[:space:]]*[^[:space:]$<{]{8,}'
  'api[-_]?key=[0-9a-fA-F-]{20,}'
  'AKIA[0-9A-Z]{16}'
  'gh[pousr]_[A-Za-z0-9]{36}'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  'sk-[A-Za-z0-9]{32,}'
)
exclude=(':!package-lock.json' ':!**/Cargo.lock' ':!scripts/scan-secrets.sh')

found=0
if [[ "${1:-}" == "--history" ]]; then
  revs=$(git rev-list --all)
  for p in "${patterns[@]}"; do
    # shellcheck disable=SC2086
    if out=$(git grep -nIE -e "$p" $revs -- . "${exclude[@]}" 2>/dev/null); then echo "$out"; found=1; fi
  done
  files=$(git log --all --name-only --format= | sort -u)
else
  for p in "${patterns[@]}"; do
    if out=$(git grep -nIE -e "$p" -- . "${exclude[@]}"); then echo "$out"; found=1; fi
  done
  files=$(git ls-files)
fi

if bad=$(echo "$files" | grep -E '(^|/)(\.env(\..+)?|id\.json|[^/]*keypair[^/]*\.json|[^/]*\.pem)$' | grep -v '\.env\.example$'); then
  echo "$bad"
  found=1
fi

if [[ $found -ne 0 ]]; then
  echo "scan-secrets: something above looks like a secret; remove it (and rotate it if it was real)" >&2
  exit 1
fi
echo "scan-secrets: clean ($( [[ "${1:-}" == "--history" ]] && echo "every commit" || echo "tracked files"))"
