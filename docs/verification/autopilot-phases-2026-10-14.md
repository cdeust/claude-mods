# Phases of every loop, advisor calls, and two turn.start bugs (2026-10-14)

Probe: a mod dumping `zetetic-autopilot.phases` at main's `turn.complete`, logging `turn.start`
(turn id, text) and `turn.step` (turn id, agent id, index), run headless with this branch's
genius and autopilot through `--plugin-dir`, in a scratch folder holding a broken `calc.py`.

## Engine fact found

`turn.start` fires for a subagent's turn too, carrying the agent's prompt as `text` and no loop
id (`TurnStartInput` is `{ text, turnId }`). Measured: `start` logs for the main prompt, then for
"Review calc.py in the current dir..." (the code-reviewer's prompt), then for the
`<agent-message ...>` continuation.

Two consequences on main 994c88b+#10:

- zetetic-genius cleared the main request's grade on the subagent's `turn.start` (a bound grade
  with a different text became `null`), so after an Agent call main's later steps ran without
  their graded effort;
- the first version of this branch reset main's phase row there (main showed only `report 1`).

Fix: main's row starts at main's own first step of a new turn id; genius keeps a bound grade
when another text starts a turn (the autopilot already matches the grade by turn id).
Regression tests: genius "a subagent's turn.start leaves the main request's grade bound to its
turn", autopilot "a subagent's steps between two of main's leave main's row whole".

## Live result after the fix (sonnet 5.5, foreground code-reviewer)

    main      running report  sonnet 5.5 medium  analysis 1 › implementation 2 › review 1 › report 1
    a15dba4a  done    review  sonnet 5.5 medium  review 2

## Mapping to the engineering loop

0 check → planning, 1 recall → analysis, 2 refine → planning, 3 investigate → analysis,
4 implement → implementation, 5 verify → verification, 6 benchmark → test, 7 review → review,
8 remember → report (`ENGINEERING_LOOP` in `hooks/phases.ts`).

## Gates

autopilot: validate passed, 56 tests, tsc clean. cockpit: validate passed, 86 tests, tsc clean.
genius: validate passed, 23 tests, tsc clean. harness-fleet: 46 tests, tsc clean.
`scripts/check-shared.sh` identical.
