---
name: cortex
description: Use when inspecting Cortex mod status, hook observations or guard refusals in Codex.
---

Run the bundled report. Pass the current native session id when available. PLUGIN_DATA must name this plugin’s data directory, as supplied to its hooks; if it is unavailable, report that the telemetry is unavailable. Never substitute another session’s events. Usage and quota fields are unknown, and no persistent terminal pane is provided. For Cortex memory health, use the actual Cortex MCP tools separately.

Resolve `scripts/run.mjs` relative to this SKILL.md and invoke it using its absolute path:

```sh
node /absolute/path/to/this/skill/scripts/run.mjs [arguments]
```

Keep paths as separate quoted arguments. Interpret returned JSON as observations and preserve errors and unknown values.
