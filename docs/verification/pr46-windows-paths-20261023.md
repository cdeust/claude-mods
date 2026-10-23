# PR46 Windows path expectations

Source: [Windows environment job 120239241341](https://github.com/cdeust/claude-mods/actions/runs/39899896318/job/120239241341), PR head `bd6ee8ec66fa28db1b09f9875e95c09fcc593291`, Claude Code 2.1.306.

The job reported 38 passes and four failures in `hygiene.hook.test.ts`.
Three successful-registration assertions expected a POSIX path although the
engine supplied a Windows drive and backslashes. The fourth failure came
from the fs.stat fixture: its exact POSIX comparison missed the normalized
Windows script path, so the missing-script case incorrectly returned a file.

Only test expectations and the fs.stat fixture matcher change. They normalize
separators and remove a drive prefix only for rooted paths, then compare the
entire expected path. The registered-message prefix remains mandatory.
Wrong roots, names and trailing components remain unequal. The supplied
script argument and unregistered-result context still use their original
spelling. Runtime modules and CI commands are unchanged.

Local verification on macOS:

- `/Users/cdeust/.local/share/claude/versions/2.1.306 plugin test mods/cortex-guard`: 42 passed before and after the change.
- Eight checks against the actual normalization helpers accepted the logged Windows spellings and rejected wrong root/name/suffix, drive-relative paths and a failure message.
- `sh scripts/check-shared.sh` and `git diff --check`: passed.

The pinned CLI refuses `node:path` imports in hook test modules, so the final
change uses no new imports. Native Windows execution of the corrected file
remains pending hosted CI.

## License diagnostic

No tracked LICENSE/COPYING file or license declaration was found in the root
package or plugin manifests. Standard `plugin validate` with the pinned CLI
reports LICENSE_MISSING but exits 0: its output explicitly states that plugin
directory checks do not alter standard validation. The same command with
`--profile directory` exits 1 for LICENSE_MISSING. No license was added or
changed as part of this test portability fix.
