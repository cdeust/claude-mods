# The learning loop: ledger, /insights outcomes, goals, per-phase calibration (2026-10-14)

## Engine facts measured before building on them

- `$.store` persists across processes: a probe mod incremented a `runs` key at `session.start`;
  two successive `claude -p` runs read `before: 0` then `before: 1` (session ids ee48c38a and
  0cc41f43).
- `/insights` (Claude Code 2.1.299, read from the binary's strings, not run): facets are
  `<config dir>/usage-data/facets/<session id>.json` with `"outcome":
  "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript"`. No
  facet exists on this machine yet: the join is tested on fixtures; it reads real ones once the
  owner runs `/insights` (a cockpit button).
- Goal files (zetetic-loop verify-goal skill): the last `status:` line is the goal's state.

## Live run (worktree mods through CLAUDE_CODE_PLUGIN_DIRS)

1. `claude -p "<fix calc.py, run the assert>"` (sonnet 5.5): one main turn recorded.
2. A new process, `claude -p "/calibrate"`:
   `Ledger: 1 turns over 1 sessions, 0 judged by /insights. Calibration: none (medium everywhere). Proposals: none.`

## Rules (own choices, stated in hooks/learn.ts)

A phase needs 40 main steps at one effort. Raise one notch when at least 25 % of those steps
had a failed tool call. Lower one notch only when at most 5 % did and at least 5 sessions judged
by /insights were achieved at 80 % or more. Range low..high. The autopilot applies a calibrated
rung as the tool-loop ceiling of that phase, never above the request's grade or under pressure.
`learning_mode` starts in observe: proposals are shown; `/calibrate apply` or the cockpit
button writes `~/.claude/zetetic-insights/calibration.json`.

## Gates

insights 15, autopilot 61, cockpit 87, genius 23, fleet 46 tests pass; validate passed and
`tsc --noEmit` clean in each; `scripts/check-shared.sh` identical (paths.ts now shared with
zetetic-insights).
