---
name: genius
description: Use when the user requests a genius reasoning pattern or task classification in Codex.
---

Run the bundled command with an optional explicitly located genius INDEX.md and skill routing table. Discover installed patterns from the actual available skills or plugin files, rather than assuming the Claude plugin registry exists. Read its emitted classification prompt, classify the user’s actual request, and select a pattern only if its trigger matches. Read the selected pattern file before applying it. State the selected pattern and rationale. The report is guidance; it does not launch a second model or alter native effort. An empty pattern list is not proof that no pattern is installed.

Resolve `scripts/run.mjs` relative to this SKILL.md and invoke it using its absolute path:

```sh
node /absolute/path/to/this/skill/scripts/run.mjs [arguments]
```

Keep paths as separate quoted arguments. Interpret returned JSON as observations and preserve errors and unknown values.
