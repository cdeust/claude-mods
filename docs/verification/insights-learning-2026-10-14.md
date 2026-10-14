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

## Review round 1 (REQUEST-CHANGES on fb180a3), what changed

- Ledger size: `$.store.set` rejects a store over 4 MiB of JSON text (claude-code types). The
  ledger is now trimmed by UTF-8 size (3 MiB) as well as count, each record measured once, on load
  and on every write; a record keeps 50 agents and counts the rest (`agentsDropped`). A write the
  store still refuses is shown in the panel (`ledger: not saved: …`), not thrown on every turn.
  Test: a 420-record agent-heavy ledger (> 4 MiB) against a store mock that rejects past 4 MiB;
  the next turn is saved and the store is back under 3 MiB. Reverting the trim fails both tests.
- `default` rows: the autopilot recorded `null` when the engine sent no effort. It now records the
  model's API default (policy.ts DEFAULT_EFFORT, sourced), so every run lands on a rung the
  calibration can read. The run effort is the effort sent: after the policy under enforce, as the
  engine received it under observe. `/calibrate` names a phase whose steps all ran at other rungs.
- Raise is a ceiling: a calibrated rung lifts only turns whose graded base is at or above it (the
  ladder never raises above the base, owner rule 2026-10-07). Stated at `proposals` in learn.ts.
- Hysteresis: the calibration keeps each phase's last move (`changes`); a phase counts only the
  runs after its move, and undoing a move needs 120 steps (3 × 40) instead of 40.
- Facets: a malformed facet is skipped and named (`1 skipped, first <session>: …`), the others are
  read. Still never run on a real facet: none exists on this machine.
- The cockpit's Apply button toasts a failed `/calibrate apply`; a store that cannot be read at
  start is named and a new ledger starts.
- An agent finishing after main's turn completed joins that turn's record, not the next one.
- Found on the way: `npm run check:codex` failed on main under Node 26 (`stripTypeScriptTypes`
  accepts only `mode: 'strip'` there). Switched to `strip`, regenerated `codex/shared`;
  `npm run test:codex` 18 pass.

## Gates

Round 2: insights 23, autopilot 62, cockpit 87, genius 23, fleet 46, guard 33, wiki 7 tests pass;
`tsc --noEmit` (typescript 5.9.3) exit 0 in all seven mods, after refreshing the ignored
`.claude-plugin/types/zetetic-insights` copies (neither `test` nor `validate` regenerates them);
`claude plugin validate` passes for all seven; `check-shared.sh` identical; codex 18 pass.

Round 1: insights 15, autopilot 61, cockpit 87, genius 23, fleet 46 tests pass; validate passed and
`tsc --noEmit` clean in each; `scripts/check-shared.sh` identical (paths.ts now shared with
zetetic-insights).
