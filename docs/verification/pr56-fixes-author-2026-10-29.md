# PR #56 review fixes, author evidence (2026-10-29)

Head reviewed: 65888e7. Remote head when this work began: d648498 (one commit after 65888e7, finding 2 only).
Gate (external signal): `claude plugin validate mods/delegate && claude plugin test mods/delegate`, as `ci.json` runs it
(unit job), on engines 2.1.306 (the CI pin) and 2.1.312. Each finding has a test that fails on the old code.

## What 65888e7..d648498 contained

`fm.ts`: `release()` became `void before.then(release)` in the `finally` of `classify` (finding 2), plus a test in
`fm.test.ts`. Finding 2 was therefore already addressed in code, but its test was wrong: on d648498 it timed out
(`(fail) a waiter that gave up does not free the slot ... Error: timed out after 5000 ms`, 79 pass / 1 fail on both
engines) because it counted microtask ticks, and it also passed against the old `release()`. It now synchronises on
events and fails on the old code (last block below).

## Verdict per finding (each verified at the source first)

| # | Verdict | Where | Test | Before (old code, new tests) | After |
|---|---|---|---|---|---|
| 1 HIGH | fixed | `register.tsx` `retried`, `captured`, `askUser`, `toolCalled` (AskUserQuestion branch), `turned`/`completed`; `types/index.d.ts` `Ask` | `nonce.test.ts` (10 tests, 4 named attacks) | the pair named by the retry was applied (`Expected: [] / Received: [` ...) | pass |
| 2 MED | already fixed by d648498; its test repaired | `fm.ts` `classify` finally | `fm.test.ts` "a waiter that gave up ..." | with `release()` restored: `AssertionError: expect(received).toBe() Expected: 1` | pass |
| 3 LOW | fixed | `register.tsx` `.catch` handler; `retried` no longer runs inside `askUser` | `nonce.test.ts` "a fault while the pending ask is read refuses the call" | `Expected: defined / Received: undefined` (the call went through) | pass |
| 4 LOW | confirmed, fixed | `fm.ts` `failureOf` | `fm.test.ts` "a rejected process.run is told apart" | TypeError gave `fm-absent` | `fm-error` |
| 5 LOW | fixed | `README.md`; `fm.ts` `warm`; `register.tsx` session.start | `fm.test.ts` warm-up; `burst.test.ts` "a warm-up that never returns ..." | `Error: timed out after 5000 ms` (warming never cleared) | pass |

### Finding 4 evidence (source, not the summary)

A probe module (scratch, not committed) called `$.process.run` from a `tool.call` hook under `claude plugin test`. On
2.1.306 and on 2.1.312 alike the call reached the engine: `PROBE Error: no implementation for process.run`, an Error
that names the event, not a TypeError. So the noun exists on the pinned engine, the comment "an engine without
`$.process` (CI pins 2.1.306)" was false, and a TypeError is a fault in the call. The 2.1.306 declarations, read in a copy the engine wrote for another mod
(`.claude/worktrees/pr30-r2/mods/cortex-guard/.claude-plugin/types/claude-code/index.d.ts`, first line "Written by
Claude Code 2.1.306."), declare `process: {` at line 3587, as the review said, and the `AskUserQuestion` result there
types `answers` as "question text -> answer string" with a separate `response?: string` for free text typed instead of
a structured option (see the README "Limits": not verified live whether "Other" text comes back in `answers`). Absence
is now only the engine's own "failed to start".

### Finding 1: threat model (STRIDE)

1. Spoofing / elevation: a refusal is obtainable by any caller (burst, warm-up, `-p`); the old retry, keyed by
   description and checked before classification, applied any pair the caller named, tagged `user`.
2. Tampering: the read-then-update was not atomic, so N parallel retries all won.
3. Repudiation: the row said `[user]` for a pair no user chose.
4. Denial: a dismissed dialog left an entry that never expired.
5. Control: the refusal's questions carry a nonce; a `tool.call` hook on the main loop's `AskUserQuestion` stores the
   user's real answer (call answered, mark issued by the mod, valid model or effort); the retry applies the stored pair
   whatever it names; the take is one `update` (compare-and-set, the last run's capture counts); `turn.start` and the
   main loop's `turn.complete` drop all entries. Invariant: a pair is applied tagged `user` only if the user chose it in
   a marked AskUserQuestion during the current turn, once. Interleavings tested: retries in parallel with and without
   an answer, an ask never answered, a declined AskUserQuestion, unmarked and unknown-mark questions, invalid answers,
   another description, a second use, a turn boundary, state down. The `typesafe_api_key` appears in no test output.

Not covered: the main loop writes the question and its options and can offer a narrowed choice; the user's answer is
what is applied. A throw inside `askUser` itself cannot be provoked now (each awaited step in it is guarded), so the
wrapper around it in the `.catch` handler is defense in depth; the state-down test covers the path to it.

## Raw output

Before = the old `register.tsx`, `fm.ts` and `types` (from a665b25) with the new tests (`fm.test.ts` did not load
there: `warm` does not exist): 65 pass, 11 fail, both engines. After = the committed state, the exact CI command.

### Before, engine 306 (failing tests)
```
2.1.306 (Claude Code)
(fail) neither model answers and nobody can be asked here: the Agent call is refused with the two questions [107.15ms]
  AssertionError: expect(received).toMatch()
  Expected: /Which model for the agent "Review the guard"\? \(haiku, sonnet, opus, fable\) \[ask [0-9a-z]+:model\]/
  Received: "delegate: no model could classify this agent (fm: fm-absent; jev: jev-nokey). Call AskUserQuestion with two questions: which model for the agent \"Review the guard\" (haiku, sonnet, opus, fable) and which effort (low, medium, high, xhigh, max). Then call Agent again with the same description, naming the model and the effort the user chose."
(fail) a warm-up that never returns is ended by its guard: the model is not warming for the rest of the session [5002.49ms]
  Error: timed out after 5000 ms
(fail) the file did not load
(fail) the refusal carries a mark in each question, and the pair the retry names is not what is applied [121.28ms]
  AssertionError: expect(received).not.toBe()
  Expected: not ""
  Received: ""
(fail) the user's answer is applied once, tagged user, and a pair typed under Other (max) counts [52.60ms]
  AssertionError: expect(received).toEqual()
  Expected: [{ model: "sonnet", effort: "max" }]
  Received: []
(fail) attack: a refusal obtained by anyone, then a pair named with no AskUserQuestion, is refused [57.16ms]
  AssertionError: expect(received).toMatch()
  Expected: /AskUserQuestion/
  Received: undefined
(fail) attack: parallel retries after one answer apply one pair, once [100.70ms]
  AssertionError: expect(received).toEqual()
  Expected: [{ model: "sonnet", effort: "high" }]
  Received: [
(fail) attack: parallel retries with no answer apply nothing [97.54ms]
  AssertionError: expect(received).toEqual()
  Expected: []
  Received: [
(fail) an answer is for the description it was asked about, and is spent by the call that used it [50.16ms]
  AssertionError: expect(received).toEqual()
  Expected: [{ model: "opus", effort: "xhigh" }]
  Received: []
(fail) attack: an AskUserQuestion with no mark, an unknown mark or a declined answer captures nothing [43.32ms]
  AssertionError: expect(received).toMatch()
  Expected: /AskUserQuestion/
  Received: undefined
(fail) a fault while the pending ask is read refuses the call, it never applies the caller's pair [21.26ms]
  AssertionError: expect(received).toBeDefined()
  Expected: defined
  Received: undefined
 65 pass
 11 fail
Ran 76 tests across 10 files. [5.71s]
```
### After, engine 306
```
2.1.306 (Claude Code)
✔ Validation passed
test exit 0
 90 pass
 0 fail
Ran 90 tests across 10 files. [1.20s]
```
### Before, engine 312 (failing tests)
```
2.1.312 (Claude Code)
(fail) neither model answers and nobody can be asked here: the Agent call is refused with the two questions [78.98ms]
  AssertionError: expect(received).toMatch()
  Expected: /Which model for the agent "Review the guard"\? \(haiku, sonnet, opus, fable\) \[ask [0-9a-z]+:model\]/
  Received: "delegate: no model could classify this agent (fm: fm-absent; jev: jev-nokey). Call AskUserQuestion with two questions: which model for the agent \"Review the guard\" (haiku, sonnet, opus, fable) and which effort (low, medium, high, xhigh, max). Then call Agent again with the same description, naming the model and the effort the user chose."
(fail) a warm-up that never returns is ended by its guard: the model is not warming for the rest of the session [5002.54ms]
  Error: timed out after 5000 ms
(fail) the file did not load
(fail) the refusal carries a mark in each question, and the pair the retry names is not what is applied [69.42ms]
  AssertionError: expect(received).not.toBe()
  Expected: not ""
  Received: ""
(fail) the user's answer is applied once, tagged user, and a pair typed under Other (max) counts [45.03ms]
  AssertionError: expect(received).toEqual()
  Expected: [{ model: "sonnet", effort: "max" }]
  Received: []
(fail) attack: a refusal obtained by anyone, then a pair named with no AskUserQuestion, is refused [56.68ms]
  AssertionError: expect(received).toMatch()
  Expected: /AskUserQuestion/
  Received: undefined
(fail) attack: parallel retries after one answer apply one pair, once [52.96ms]
  AssertionError: expect(received).toEqual()
  Expected: [{ model: "sonnet", effort: "high" }]
  Received: [
(fail) attack: parallel retries with no answer apply nothing [88.58ms]
  AssertionError: expect(received).toEqual()
  Expected: []
  Received: [
(fail) an answer is for the description it was asked about, and is spent by the call that used it [45.29ms]
  AssertionError: expect(received).toEqual()
  Expected: [{ model: "opus", effort: "xhigh" }]
  Received: []
(fail) attack: an AskUserQuestion with no mark, an unknown mark or a declined answer captures nothing [56.01ms]
  AssertionError: expect(received).toMatch()
  Expected: /AskUserQuestion/
  Received: undefined
(fail) a fault while the pending ask is read refuses the call, it never applies the caller's pair [28.11ms]
  AssertionError: expect(received).toBeDefined()
  Expected: defined
  Received: undefined
 65 pass
 11 fail
Ran 76 tests across 10 files. [5.72s]
```
### After, engine 312
```
2.1.312 (Claude Code)
✔ Validation passed
test exit 0
 90 pass
 0 fail
Ran 90 tests across 10 files. [1.62s]
```
### Finding 2 alone: old `release()` restored on d648498 with the repaired test (engine 2.1.312)
```
(fail) a waiter that gave up does not free the slot: a later call still waits for the one running [0.43ms]
  AssertionError: expect(received).toBe()
  
  Expected: 1
  Received: 2
```

# Round 2 (review of 75a391f): `docs/verification/pr56-review-round2-2026-10-29.md`

All four findings were verified at the source by the reviewer in the 2.1.306 d.ts and binary (input schema declares
`answers?: {}`, `call()` returns the input's answers, `afkTimeoutMs` on the output, `TurnStartInput` fires for
subagents) and are accepted. Tests: `hooks/review2.test.ts` (R1, R1b, R2, R2b, R3, R4). Deviation from the reviewer's R3:
after the fix the user may legitimately pick `fable`, so R3 asserts what reaches the dialog (the mod's text, all
options, no "cancel") instead of an empty `sent`.

| # | Fix | Where |
|---|---|---|
| M1 | `turned` returns `next(e)` when `agentId` is defined | `register.tsx` `turned` |
| M2 | `canonical` strips `answers`, `annotations`, `response`, `afkTimeoutMs` from the call; nothing is captured when the call carried any | `register.tsx` `canonical`, `toolCalled` |
| M3 | marked questions are rewritten to `canonicalQuestion` (text, options) before `next` | `register.tsx` `canonicalQuestion`, `canonical` |
| L1 | a result carrying `afkTimeoutMs` is not captured | `register.tsx` `captured` |

README: the turn-boundary and "Other" statements are replaced by what the binary shows; the "narrowed choice" caveat is
gone. Not verified live: the whole path in an interactive session; that the engine accepts a rewritten `questions`
(the test engine does; the schema allows 2-4 options with a description each, which the canonical questions respect).

### Before (75a391f source, new tests), engine 306
```
2.1.306 (Claude Code)
(fail) R1 a subagent turn.start after the user answered does not drop the answer [111.19ms]
  AssertionError: expect(received).toBeUndefined()
  Expected: undefined
  Received: "delegate: no model could classify this agent (fm: fm-absent; jev: jev-nokey). Call AskUserQuestion with two questions, worded exactly: \"Which model for the agent \"Review the guard\"? (haiku, sonnet, opus, fable) [ask 2npex0g:model]\" and \"Which effort for the agent \"Review the guard\"? (low, medium, high, xhigh, max) [ask 2npex0g:effort]\". Then call Agent again with the same description: the mod applies the model and the effort the user chose, whatever that call names."
(fail) R1b a subagent turn.start between the refusal and the AskUserQuestion does not drop the ask [68.00ms]
  AssertionError: expect(received).toEqual()
  Expected: [{ model: "sonnet", effort: "high" }]
  Received: []
(fail) R2 answers the main loop wrote into the AskUserQuestion input are not the user's choice [93.25ms]
  AssertionError: expect(received).toEqual()
  Expected: []
  Received: [{ model: "fable", effort: "max" }]
(fail) R2b nor are annotations or a response the main loop wrote [115.66ms]
  AssertionError: expect(received).toEqual()
  Expected: []
  Received: [{ model: "fable", effort: "max" }]
(fail) R3 a reworded, narrowed question reaches the user as the mod worded it, with every option [172.39ms]
  AssertionError: expect(received).toEqual()
  Expected: [
  Received: [
(fail) R4 an AskUserQuestion that auto-resolved on idle (afkTimeoutMs) is not a choice [75.64ms]
  AssertionError: expect(received).toEqual()
  Expected: []
  Received: [{ model: "opus", effort: "high" }]
 90 pass
 6 fail
Ran 96 tests across 11 files. [1.58s]
```
### After, exact CI command, engine 306
```
2.1.306 (Claude Code)
✔ Validation passed
test exit 0
 96 pass
 0 fail
Ran 96 tests across 11 files. [1.36s]
```
### Before (75a391f source, new tests), engine 312
```
2.1.312 (Claude Code)
(fail) R1 a subagent turn.start after the user answered does not drop the answer [109.22ms]
  AssertionError: expect(received).toBeUndefined()
  Expected: undefined
  Received: "delegate: no model could classify this agent (fm: fm-absent; jev: jev-nokey). Call AskUserQuestion with two questions, worded exactly: \"Which model for the agent \"Review the guard\"? (haiku, sonnet, opus, fable) [ask 2f9r1t4:model]\" and \"Which effort for the agent \"Review the guard\"? (low, medium, high, xhigh, max) [ask 2f9r1t4:effort]\". Then call Agent again with the same description: the mod applies the model and the effort the user chose, whatever that call names."
(fail) R1b a subagent turn.start between the refusal and the AskUserQuestion does not drop the ask [70.26ms]
  AssertionError: expect(received).toEqual()
  Expected: [{ model: "sonnet", effort: "high" }]
  Received: []
(fail) R2 answers the main loop wrote into the AskUserQuestion input are not the user's choice [93.04ms]
  AssertionError: expect(received).toEqual()
  Expected: []
  Received: [{ model: "fable", effort: "max" }]
(fail) R2b nor are annotations or a response the main loop wrote [101.53ms]
  AssertionError: expect(received).toEqual()
  Expected: []
  Received: [{ model: "fable", effort: "max" }]
(fail) R3 a reworded, narrowed question reaches the user as the mod worded it, with every option [80.72ms]
  AssertionError: expect(received).toEqual()
  Expected: [
  Received: [
(fail) R4 an AskUserQuestion that auto-resolved on idle (afkTimeoutMs) is not a choice [42.02ms]
  AssertionError: expect(received).toEqual()
  Expected: []
  Received: [{ model: "opus", effort: "high" }]
 90 pass
 6 fail
Ran 96 tests across 11 files. [1.15s]
```
### After, exact CI command, engine 312
```
2.1.312 (Claude Code)
✔ Validation passed
test exit 0
 96 pass
 0 fail
Ran 96 tests across 11 files. [1.20s]
```
