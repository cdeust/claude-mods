---
name: fleet
description: Use when checking installed Codex plugins or open GitHub PRs and issues for named repositories.
---

Run the bundled report with the owner/repo arguments the user requested. Without repository arguments it reads only the Codex plugin catalog. Every GitHub call is read-only. Report errors and list truncation explicitly; no checks or skipped checks are not green. The script does not merge, push, comment, create issues or upgrade plugins. Those actions need their own user authorization and repository workflow.

Resolve `scripts/run.mjs` relative to this SKILL.md and invoke it using its absolute path:

```sh
node /absolute/path/to/this/skill/scripts/run.mjs [arguments]
```

Keep paths as separate quoted arguments. Interpret returned JSON as observations and preserve errors and unknown values.
