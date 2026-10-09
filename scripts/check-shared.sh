#!/bin/sh
# Fails when the copies of a file shared by several mods differ. A mod cannot import a file from
# another mod (the engine refuses it: "outside the plugin's folder"), so a small pure file is
# copied into each mod that needs it and this script keeps the copies byte-identical.
#
#   sh scripts/check-shared.sh
#
# exit 0: every copy of every shared file equals its reference copy
# exit 1: a copy differs or is missing (the differing paths are printed)
#
# Each line below is: file, reference mod (its copy is the one the others are compared with), the
# other mods that carry a copy.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
status=0
while read -r file reference users; do
  for mod in $users; do
    if ! cmp -s "$root/mods/$reference/hooks/$file" "$root/mods/$mod/hooks/$file"; then
      echo "DIFFERS: mods/$mod/hooks/$file is not mods/$reference/hooks/$file" >&2
      status=1
    fi
  done
done <<'LIST'
paths.ts harness-fleet cortex-guard zetetic-genius zetetic-autopilot cortex-cockpit
paths.test.ts harness-fleet cortex-guard zetetic-genius zetetic-autopilot cortex-cockpit
rules.ts cortex-guard cortex-cockpit
rules.test.ts cortex-guard cortex-cockpit
LIST
[ "$status" -eq 0 ] && echo "every shared file is identical in all of its mods"
exit "$status"
