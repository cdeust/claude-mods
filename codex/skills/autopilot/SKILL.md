---
name: autopilot
description: Use when choosing reasoning effort for a Codex task or checking the limits of automatic model routing.
---

Classify the request using the shared taxonomy: routine (reading/I/O), planned (specified implementation), bugfix (clear defect), analysis (design/research), critical (correctness/concurrency/security/data loss). Run the bundled command with that class. Report its recommended effort as advisory. Native hooks do not change the root model or effort at each inference step, do not supply quota pressure and do not trim arbitrary native tool results. Do not claim enforcement. Preserve any explicit caller-selected model/effort and fork behavior for subagents; this plugin does not rewrite their arguments.

Resolve `scripts/run.mjs` relative to this SKILL.md and invoke it using its absolute path:

```sh
node /absolute/path/to/this/skill/scripts/run.mjs [arguments]
```

Keep paths as separate quoted arguments. Interpret returned JSON as observations and preserve errors and unknown values.
