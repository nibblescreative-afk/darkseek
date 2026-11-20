#!/usr/bin/env bash
# Creates or updates every label in .github/labels.json. It never deletes a label.
# The Labels workflow runs it; locally it needs `gh` signed in with access to the repository.
set -euo pipefail
cd "$(dirname "$0")/.."
jq -c '.[]' .github/labels.json | while IFS= read -r label; do
  gh label create "$(jq -r '.name' <<<"$label")" \
    --color "$(jq -r '.color' <<<"$label")" \
    --description "$(jq -r '.description' <<<"$label")" \
    --force
done
