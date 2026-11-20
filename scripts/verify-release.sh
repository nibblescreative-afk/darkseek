#!/usr/bin/env bash
# Checks a DarkSeek release (docs/verify.md).
#
#   scripts/verify-release.sh <tag> [--dir <assets dir>] [--cluster devnet|mainnet-beta|localnet]
#                             [--program <id>] [--rpc <url>] [--web <site url>]
#
#  1. downloads the release assets into a temporary directory (or uses --dir)
#  2. checks every asset against SHA256SUMS
#  3. checks each asset's build provenance attestation (needs the GitHub CLI)
#  4. --cluster: compares the release's program with the deployed one
#  5. --web: checks the site serves the website build published with the release
set -euo pipefail

REPO=nibblescreative-afk/darkseek
tag=${1:?usage: scripts/verify-release.sh <tag> [--dir d] [--cluster c] [--rpc url] [--web url]}
shift
dir="" cluster="" program="" rpc="" web=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) dir=$2; shift 2 ;;
    --cluster) cluster=$2; shift 2 ;;
    --program) program=$2; shift 2 ;;
    --rpc) rpc=$2; shift 2 ;;
    --web) web=${2%/}; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
root=$(cd "$(dirname "$0")/.." && pwd)
version=${tag#v}
failed=0
say() { printf '%-5s %s\n' "$1" "$2"; }

if [[ -z "$dir" ]]; then
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  for asset in SHA256SUMS darkseek_vault.so darkseek_vault.json "darkseek-sdk-$version.tgz"; do
    curl -fsSL -o "$dir/$asset" "https://github.com/$REPO/releases/download/$tag/$asset"
  done
  curl -fsSL -o "$dir/web-build.json" "https://github.com/$REPO/releases/download/$tag/web-build.json" 2>/dev/null || rm -f "$dir/web-build.json"
fi

echo "release $tag in $dir"
if (cd "$dir" && sha256sum --check --strict SHA256SUMS >/dev/null); then
  say ok "every asset matches SHA256SUMS"
else
  (cd "$dir" && sha256sum --check SHA256SUMS) || true
  say FAIL "checksums"; failed=1
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  while read -r _ file; do
    file=${file#\*}
    if gh attestation verify "$dir/$file" --repo "$REPO" >/dev/null 2>&1; then
      say ok "$file was built by $REPO's release workflow"
    else
      say FAIL "no valid attestation for $file"; failed=1
    fi
  done < "$dir/SHA256SUMS"
else
  say skip "attestations (install the GitHub CLI and run gh auth login)"
fi

verify() {
  if [[ -x "$root/node_modules/.bin/tsx" ]]; then
    "$root/node_modules/.bin/tsx" "$root/packages/sdk/src/cli.ts" "$@"
  else
    npx --yes -p "$dir/darkseek-sdk-$version.tgz" darkseek-verify "$@"
  fi
}

if [[ -n "$cluster" ]]; then
  args=(program --cluster "$cluster" --so "$dir/darkseek_vault.so")
  [[ -n "$program" ]] && args+=(--program "$program")
  [[ -n "$rpc" ]] && args+=(--rpc "$rpc")
  if verify "${args[@]}"; then say ok "the deployed program is this release"; else say FAIL "the deployed program differs from this release"; failed=1; fi
fi

if [[ -n "$web" ]]; then
  served=$(mktemp)
  if ! curl -fsSL -o "$served" "$web/.well-known/darkseek-build.json"; then
    say FAIL "$web serves no build manifest"; failed=1
  elif [[ -f "$dir/web-build.json" ]] && ! cmp -s <(jq -S . "$served") <(jq -S . "$dir/web-build.json"); then
    say FAIL "$web serves a different build manifest than the release"; failed=1
  elif "$root/node_modules/.bin/tsx" "$root/scripts/web-manifest.ts" --check "$served" "$web"; then
    say ok "$web serves the build published with $tag"
  else
    say FAIL "$web serves files that differ from its manifest"; failed=1
  fi
  rm -f "$served"
fi

exit $failed
