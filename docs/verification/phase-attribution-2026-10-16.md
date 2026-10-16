# Phase attribution and undesigned delegations, 2026-10-16

What the owner saw in `/mission`: the lanes, the steps by model and the effort never show `test`,
and what they show does not match what the agents did. The ledger brief of the same day reports
95 delegations, 44 of them without a DESIGN block.

## Method

`phase-attribution-2026-10-16/probe.mjs` reads every `tool_use` of the most recent transcripts under
`~/.claude/projects` (main sessions and `subagents/`) and classifies each call with `toolPhase` from
a given copy of `mods/zetetic-autopilot/hooks/phases.ts`. It ran on HEAD's copy (`git show
HEAD:…/phases.ts`) and on the working copy, over the same 48 files.

`deleg.mjs` (with `pd.mjs`, a copy of insights' `parseDesign`) reads every `Agent` call of the
last four days and says whether its prompt carries a DESIGN block.

## Findings

Calls per phase, same 48 transcripts:

| phase          | before | after |
|----------------|-------:|------:|
| analysis       |    306 |   820 |
| implementation |    928 |   393 |
| test           |     75 |    98 |
| verification   |     11 |     9 |
| report         |     45 |    45 |

Causes, each seen in the replay:

1. `TEST_RUN` was anchored on a bare interpreter: `.venv/bin/python -m pytest`, `node --test`,
   `uv run pytest`, `timeout N npx vitest` fell to `implementation`.
2. Any command the patterns did not name was `implementation`: `ps`, `cut`, `awk`, `pgrep`, the
   loop keywords `for`, `do`, `until`, variable assignments.
3. The line was split on `|` and `;` inside quotes: `grep -n "a\|b"` made a segment `b"`, read as
   an implementation.
4. `sh -c '<script>'` and `$( … )` hid the command they run.
5. An agent whose type names a phase stayed in it for its whole life, so an `engineer` that ran
   pytest was drawn as one `implementation` bar, never `test`.
6. Inside a turn, the model sequence put main's runs first and the agents after, whatever the time.

Delegations: 22 `Agent` calls from main in the last four days, none with a DESIGN block. Nothing
enforced the dispatch-contract skill; insights only counted the miss after the fact.

## Changes

- autopilot 0.6.0: the test runners above, wrappers dropped before a command is read, quoted text
  blanked, `sh -c` and `$( )` read, unnamed commands neutral, explicit writes and file redirections
  `implementation`. A typed agent falls back to its type's phase only on a step that reads or says
  nothing. Under `enforce`, `agent.spawn` refuses a delegation whose prompt has no `DESIGN` line
  (forks, workflow agents and teammates exempt) and logs a `design` decision; under `observe` it
  logs only.
- insights 0.11.0: main runs and agents keep `since`; a record that times every part lays its
  model sequence out by time.

## Limits

- `pytest && git commit` is still `report` (the furthest phase of the line wins).
- Ledger records written before these versions keep their phases: `test` reaches the learning
  curves after two turns with a test run in main; agents' steps never feed them.
- A typed agent's `loop.phase`, and so `AgentRecord.phase` in the ledger, is now the phase of its
  last step, no longer its type's. Nothing reads that field today. The steps an agent made before
  its spawn answered are still merged into its type's phase (`spawned`).
- Under enforce no mod in this repository spawns an agent with `$.agent.spawn`, so the gate only
  ever refuses the model's own delegations.
- The effort shown for a step the engine sent no effort for is the model's API default
  (policy.ts), not a measured value.
