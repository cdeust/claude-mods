#!/usr/bin/env bash
# source: https://github.com/cdeust/claude-mods/tree/e899dc0be0200444f478f3f918c66bbea1f2964e
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
case "${1:-}" in
  setup)
    node --version
    claude --version
    ;;
  unit)
    shopt -s nullglob
    mods=(mods/*/.claude-plugin/plugin.json)
    ((${#mods[@]})) || { echo 'No Claude mods discovered' >&2; exit 1; }
    for manifest in "${mods[@]}"; do claude plugin test "${manifest%/.claude-plugin/plugin.json}"; done
    ;;
  regression) node --test codex/tests/runtime.test.mjs ;;
  e2e) node --test codex/tests/commands.test.mjs ;;
  environment)
    sh scripts/check-shared.sh
    npm run check:codex
    ;;
  installation)
    shopt -s nullglob
    mods=(mods/*/.claude-plugin/plugin.json)
    ((${#mods[@]})) || exit 1
    for manifest in "${mods[@]}"; do claude plugin validate "${manifest%/.claude-plugin/plugin.json}"; done
    python3 .github/ci/package_probe.py
    ;;
  release-version)
    python3 -c 'import json; print("tag=v"+json.load(open("codex/.codex-plugin/plugin.json"))["version"])'
    ;;
  *) echo 'Usage: run.sh setup|unit|regression|e2e|environment|installation|release-version' >&2; exit 2 ;;
esac
