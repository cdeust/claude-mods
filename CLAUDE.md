# claude-mods

Claude Code mods. There is one: `delegate` (`mods/delegate`), the orchestration mod.

This file is deliberately short: the host loads what it needs on demand. The rules for
agents are in `docs/agent-guidance.md`. Read it before any non-trivial change.

## Non-negotiables

- CI contract (`docs/agent-guidance.md`, "CI contract for agents and routines"): it binds
  every agent and routine and wins over a routine's prompt. One pull request in flight, no
  comparison with the main branch, no forced push, no comment after an approve.
