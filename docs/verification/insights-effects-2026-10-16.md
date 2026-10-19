# zetetic-insights 0.9.0, PR #26 review round 1: fixes and their proof (2026-10-16)

Base: origin/main 29bfb28 (`git merge-base HEAD origin/main` equals it; `git merge-tree --write-tree origin/main HEAD` exits 0).
The branch was rebased by replaying its own four commits (stats, rungs and effect, 0.9.0) onto main; #24's commits, squash-merged as 117d1cb, are no longer in its history. The one conflict was plugin.json (version and description): the branch's 0.9.0 wins.

## Findings 1 and 2: red before, green after

Tests were written first and run against the old behaviour (the new signatures stubbed, nothing else changed). Output of that run, filtered to the failures and the summary line:

```
(fail) P1 turns without a graded base are not the move population: a raise that changed nothing is not a benefit [0.28ms]
  AssertionError: expect(received).not.toBe()
  Expected: not "benefit"
  Received: "benefit"
(fail) P3 stuck-escalated steps do not make a no-op raise read as harm [0.19ms]
  AssertionError: expect(received).toEqual()
  Expected: ["critical"]
  Received: ["bugfix", "critical"]
(fail) a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides [0.14ms]
  AssertionError: expect(received).toEqual()
(fail) a lowering move reaches the turns that ran at the rung left: the reach is the higher of the two rungs [0.11ms]
  AssertionError: expect(received).toEqual()
  Expected: { critical: { steps: 100, errors: 10 } }
(fail) P2 a move made under 0.8.x (changes, no moves) has a defined state: no baseline [0.15ms]
  AssertionError: expect(received).toHaveLength()
  Expected: length 1
  Received: length 0
(fail) P2 a phase moved under 0.8.x can be undone when the evidence supports it; the same evidence with a measured, not-harmful move cannot [0.72ms]
  AssertionError: expect(received).toEqual()
  Expected: ["test high->medium"]
  Received: []
 236 pass
 6 fail
Ran 242 tests across 16 files. [12.39s]
```

P1 (turns without a graded base), P3 (stuck-escalated steps), the two reach tests and the two P2 tests failed for the stated reason. After the change `claude plugin test mods/zetetic-insights` reports 257 pass, 0 fail.

What changed, by cause (hooks/reach.ts). A step sits on a rung because of the ceiling, the stuck escalation, pressure, or (the first request) its base. A move is now compared on the steps the ceiling decided: graded base at least the higher rung of the move, not on an escalated rung, not under pressure. The ledger records `base` and `pressured` on the turn and `escalated` on the run. The autopilot exposes no per-run flag: the graded effort is zetetic-genius `classified.effort` (already read), the escalation is the `stuck` entries of `policy.decisions` (with the effort raised to). The insights mod derives the flags from those. zetetic-autopilot is untouched.

Finding 2: `movesOf` reads a calibration with `changes` and no `moves` as moves with no baseline; the credit `no-baseline` lets the rung evidence decide the undo.

## Mutation set: the review's 28, and 16 for this change

Method: each edit is applied to a copy of the mod, `claude plugin test` runs, the file is restored. M-ids are the review's (edits reconstructed from its names and line references); N-ids test the new code.

| id | file | result | first failing test |
|---|---|---|---|
| M1 | rungs.ts | KILLED | M1 a raise needs the phase interval wholly above the reference: a higher rate whose interval overlaps it is not a move |
| M2 | rungs.ts | KILLED | a raise is held back when the rung above, in the task classes both ran, fails confidently more |
| M3 | rungs.ts | KILLED | M3 a lowering is held back when the rung below, in the task classes both ran, fails confidently more |
| M4 | rungs.ts | KILLED | M4 a lowering needs the Wilson lower bound of the achieved share above half: 3 of 4 judged sessions is not enough |
| M5 | rungs.ts | KILLED | M22 enforce freezes the move like /calibrate apply: the pre statistics of the steps it governed are in the file |
| M6 | rungs.ts | KILLED | a verdict that rests on one session is not a move: it does not survive that session being left out |
| M7 | rungs.ts | KILLED | P2 a phase moved under 0.8.x can be undone when the evidence supports it; the same evidence with a measured, not-harmful move cannot |
| M8 | rungs.ts | KILLED | the rung that ran is read: a phase that ran only at low is not moved by a medium ceiling, and the finding says the ceiling cannot reach it |
| M9 | rungs.ts | KILLED | M9 the rung above is compared on the classes both rungs ran, not on the classes only it ran |
| M10 | stats.ts | KILLED | rows keep the runs of every rung, pre-move ones included, each with its Wilson interval and whether it is resolved |
| M11 | stats.ts | SURVIVED | - |
| M12 | effect.ts | KILLED | the outcome is compared on judged sessions; a session with runs on both sides belongs to neither |
| M13 | effect.ts | KILLED | the move is credited with harm only on a comparison of the same phase and the same task classes |
| M14 | effect.ts | KILLED | the outcome is compared on judged sessions; a session with runs on both sides belongs to neither |
| M15 | effect.ts | KILLED | M15 sessions achieved with confidence where they were not credit a benefit even when the failed calls did not move |
| M16 | effect.ts | KILLED | M16 the runs after the move are not in its pre statistics |
| M17 | effect.ts | KILLED | M17 the runs before a move are not in the post statistics that a later move freezes |
| M18 | effect.ts | KILLED | M18 the runs before a move are not in the post of its effect while it is the last move |
| M19 | effect.ts | KILLED | M19 effectsOf credits each phase by its last move, not its first |
| M20 | learn.ts | KILLED | M20 the moves of a calibration file survive reading it: their frozen pre statistics are never discarded |
| M21 | register.tsx | KILLED | observe: a main turn is kept in the ledger and its evidence proposed with its intervals, not applied |
| M22 | register.tsx | KILLED | M22 enforce freezes the move like /calibrate apply: the pre statistics of the steps it governed are in the file |
| M23 | brief.ts | KILLED | a credited calibration move is a line of the brief with its delta and interval; an inconclusive one is not |
| M24 | brief.ts | KILLED | M24 the brief shows the newest credited move, not the oldest |
| M25 | delegations.ts | KILLED | underpowered: haiku with at least 4 steps and a failed-call rate of 0.25 or more |
| M26 | rungs.ts | KILLED | observe: a main turn is kept in the ledger and its evidence proposed with its intervals, not applied |
| M27 | stats.ts | KILLED | a phase failing confidently less than the others is lowered only when its sessions were achieved with confidence |
| M28 | rungs.ts | KILLED | a phase failing confidently more than the others at its rung is raised, with both intervals in the evidence |
| N1 | reach.ts | KILLED | a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides |
| N2 | reach.ts | KILLED | a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides |
| N3 | reach.ts | KILLED | P1 turns without a graded base are not the move population: a raise that changed nothing is not a benefit |
| N4 | reach.ts | KILLED | a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides |
| N5 | reach.ts | KILLED | a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides |
| N6 | effect.ts | KILLED | P2 a move made under 0.8.x (changes, no moves) has a defined state: no baseline |
| N7 | rungs.ts | KILLED | P2 a phase moved under 0.8.x can be undone when the evidence supports it; the same evidence with a measured, not-harmful move cannot |
| N8 | rungs.ts | KILLED | a phase that ran only below its ceiling gets a finding saying its ceiling is unmeasured, not silence |
| N9 | reach.ts | KILLED | a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised |
| N10 | register.tsx | KILLED | a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised |
| N11 | effect.ts | KILLED | P1 turns without a graded base are not the move population: a raise that changed nothing is not a benefit |
| N12 | effect.ts | KILLED | P1 turns without a graded base are not the move population: a raise that changed nothing is not a benefit |
| N13 | register.tsx | KILLED | a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised |
| N14 | register.tsx | KILLED | a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised |
| N15 | rungs.ts | KILLED | a run keeps why it sat on its rung: the graded base of its turn, the stuck escalation, the pressure |
| N16 | effect.ts | SURVIVED | - |

M11 (`<=` to `<` in isResolved) survives and is equivalent in practice: the two differ only when a Wilson half-width equals 0.1 to the last bit.
N16 (dropping the `pre.steps === 0` clause of `creditOf`) survives and is equivalent: both sides are restricted to the same shared classes, so they are empty together; only rows of zero steps differ.

## Raw mutation output

```
M1 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M1 a raise needs the phase interval wholly above the reference: a higher rate whose interval overlaps it is not a move
M2 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) a raise is held back when the rung above, in the task classes both ran, fails confidently more
M3 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M3 a lowering is held back when the rung below, in the task classes both ran, fails confidently more
M4 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M4 a lowering needs the Wilson lower bound of the achieved share above half: 3 of 4 judged sessions is not enough
M5 [rungs.ts]: KILLED pass=249 fail=8 exit=1
    (fail) M22 enforce freezes the move like /calibrate apply: the pre statistics of the steps it governed are in the file
    (fail) observe: a main turn is kept in the ledger and its evidence proposed with its intervals, not applied
    (fail) enforce: the proposal is written to the calibration file as soon as it is made
    (fail) a phase failing confidently more than the others at its rung is raised, with both intervals in the evidence
M6 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) a verdict that rests on one session is not a move: it does not survive that session being left out
M7 [rungs.ts]: KILLED pass=255 fail=2 exit=1
    (fail) P2 a phase moved under 0.8.x can be undone when the evidence supports it; the same evidence with a measured, not-harmful move cannot
    (fail) undoing a phase's last move needs that move's measured effect to be harm
M8 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) the rung that ran is read: a phase that ran only at low is not moved by a medium ceiling, and the finding says the ceiling cannot reach it
M9 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M9 the rung above is compared on the classes both rungs ran, not on the classes only it ran
M10 [stats.ts]: KILLED pass=253 fail=4 exit=1
    (fail) rows keep the runs of every rung, pre-move ones included, each with its Wilson interval and whether it is resolved
    (fail) the old rule raised 12 failures in 40 steps; 40 steps cannot resolve 30% to +-10 points, so it no longer does
    (fail) stepsFor: the steps that resolve a rate to +-10 points; 51 at a quarter, the old 40 was too few
    (fail) isResolved: narrow enough or not; no trials is never resolved
M11 [stats.ts]: SURVIVED pass=257 fail=0 exit=0
M12 [effect.ts]: KILLED pass=256 fail=1 exit=1
    (fail) the outcome is compared on judged sessions; a session with runs on both sides belongs to neither
M13 [effect.ts]: KILLED pass=254 fail=3 exit=1
    (fail) the move is credited with harm only on a comparison of the same phase and the same task classes
    (fail) the pre statistics survive the ledger trimming the runs they came from
    (fail) effectLine states the delta in points with its interval and the steps; one move gives its phase that credit
M14 [effect.ts]: KILLED pass=256 fail=1 exit=1
    (fail) the outcome is compared on judged sessions; a session with runs on both sides belongs to neither
M15 [effect.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M15 sessions achieved with confidence where they were not credit a benefit even when the failed calls did not move
M16 [effect.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M16 the runs after the move are not in its pre statistics
M17 [effect.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M17 the runs before a move are not in the post statistics that a later move freezes
M18 [effect.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M18 the runs before a move are not in the post of its effect while it is the last move
M19 [effect.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M19 effectsOf credits each phase by its last move, not its first
M20 [learn.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M20 the moves of a calibration file survive reading it: their frozen pre statistics are never discarded
M21 [register.tsx]: KILLED pass=256 fail=1 exit=1
    (fail) observe: a main turn is kept in the ledger and its evidence proposed with its intervals, not applied
M22 [register.tsx]: KILLED pass=256 fail=1 exit=1
    (fail) M22 enforce freezes the move like /calibrate apply: the pre statistics of the steps it governed are in the file
M23 [brief.ts]: KILLED pass=256 fail=1 exit=1
    (fail) a credited calibration move is a line of the brief with its delta and interval; an inconclusive one is not
M24 [brief.ts]: KILLED pass=256 fail=1 exit=1
    (fail) M24 the brief shows the newest credited move, not the oldest
M25 [delegations.ts]: KILLED pass=256 fail=1 exit=1
    (fail) underpowered: haiku with at least 4 steps and a failed-call rate of 0.25 or more
M26 [rungs.ts]: KILLED pass=254 fail=3 exit=1
    (fail) observe: a main turn is kept in the ledger and its evidence proposed with its intervals, not applied
    (fail) a phase failing confidently more than the others at its rung is raised, with both intervals in the evidence
    (fail) no other phase at the rung, no reference: the phase is described, not moved
M27 [stats.ts]: KILLED pass=253 fail=4 exit=1
    (fail) a phase failing confidently less than the others is lowered only when its sessions were achieved with confidence
    (fail) the z is the one-sided 95% normal quantile
    (fail) stepsFor: the steps that resolve a rate to +-10 points; 51 at a quarter, the old 40 was too few
    (fail) isResolved: narrow enough or not; no trials is never resolved
M28 [rungs.ts]: KILLED pass=252 fail=5 exit=1
    (fail) a phase failing confidently more than the others at its rung is raised, with both intervals in the evidence
    (fail) a verdict that rests on one session is not a move: it does not survive that session being left out
    (fail) a phase failing confidently less than the others is lowered only when its sessions were achieved with confidence
    (fail) undoing a phase's last move needs that move's measured effect to be harm
N1 [reach.ts]: KILLED pass=255 fail=2 exit=1
    (fail) a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides
    (fail) a run is governed by a move when its base is graded and at least the reach, and no escalation or pressure moved it
N2 [reach.ts]: KILLED pass=255 fail=2 exit=1
    (fail) a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides
    (fail) a run is governed by a move when its base is graded and at least the reach, and no escalation or pressure moved it
N3 [reach.ts]: KILLED pass=254 fail=3 exit=1
    (fail) P1 turns without a graded base are not the move population: a raise that changed nothing is not a benefit
    (fail) a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides
    (fail) a run is governed by a move when its base is graded and at least the reach, and no escalation or pressure moved it
N4 [reach.ts]: KILLED pass=254 fail=3 exit=1
    (fail) a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides
    (fail) a lowering move reaches the turns that ran at the rung left: the reach is the higher of the two rungs
    (fail) a run is governed by a move when its base is graded and at least the reach, and no escalation or pressure moved it
N5 [reach.ts]: KILLED pass=254 fail=3 exit=1
    (fail) a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides
    (fail) a lowering move reaches the turns that ran at the rung left: the reach is the higher of the two rungs
    (fail) a run is governed by a move when its base is graded and at least the reach, and no escalation or pressure moved it
N6 [effect.ts]: KILLED pass=254 fail=3 exit=1
    (fail) P2 a move made under 0.8.x (changes, no moves) has a defined state: no baseline
    (fail) P2 a phase moved under 0.8.x can be undone when the evidence supports it; the same evidence with a measured, not-harmful move cannot
    (fail) P2 through the file: a 0.8.x calibration (changes, no moves) is read, its move undone when the evidence supports it
N7 [rungs.ts]: KILLED pass=255 fail=2 exit=1
    (fail) P2 a phase moved under 0.8.x can be undone when the evidence supports it; the same evidence with a measured, not-harmful move cannot
    (fail) P2 through the file: a 0.8.x calibration (changes, no moves) is read, its move undone when the evidence supports it
N8 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) a phase that ran only below its ceiling gets a finding saying its ceiling is unmeasured, not silence
N9 [reach.ts]: KILLED pass=255 fail=2 exit=1
    (fail) a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised
    (fail) the runs at the effort a stuck decision raised to are marked escalated; the others are returned as they were
N10 [register.tsx]: KILLED pass=255 fail=2 exit=1
    (fail) a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised
    (fail) observe: a main turn is kept in the ledger and its evidence proposed with its intervals, not applied
N11 [effect.ts]: KILLED pass=253 fail=4 exit=1
    (fail) P1 turns without a graded base are not the move population: a raise that changed nothing is not a benefit
    (fail) P2 a move made under 0.8.x (changes, no moves) has a defined state: no baseline
    (fail) P2 a phase moved under 0.8.x can be undone when the evidence supports it; the same evidence with a measured, not-harmful move cannot
    (fail) P2 through the file: a 0.8.x calibration (changes, no moves) is read, its move undone when the evidence supports it
N12 [effect.ts]: KILLED pass=253 fail=4 exit=1
    (fail) P1 turns without a graded base are not the move population: a raise that changed nothing is not a benefit
    (fail) P3 stuck-escalated steps do not make a no-op raise read as harm
    (fail) a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides
    (fail) a lowering move reaches the turns that ran at the rung left: the reach is the higher of the two rungs
N13 [register.tsx]: KILLED pass=256 fail=1 exit=1
    (fail) a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised
N14 [register.tsx]: KILLED pass=256 fail=1 exit=1
    (fail) a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised
N15 [rungs.ts]: KILLED pass=256 fail=1 exit=1
    (fail) a run keeps why it sat on its rung: the graded base of its turn, the stuck escalation, the pressure
N16 [effect.ts]: SURVIVED pass=257 fail=0 exit=0
```
