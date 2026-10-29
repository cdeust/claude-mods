# PR #56, author, round 3 (fixes for the review of 75a391f..32cf9df), 2026-10-29

Verdict comment of the round: https://github.com/cdeust/claude-mods/pull/56#issuecomment-6504771966
Base: 32cf9df. Gate (external signal): `claude plugin validate mods/delegate && claude plugin test mods/delegate`,
engines 2.1.306 (the CI pin, `npm install @anthropic-ai/claude-code@2.1.306` into a scratch prefix) and 2.1.312.
Method: the new tests were written first (`hooks/review3.test.ts`) and run on the unchanged source: 98 pass, 9 fail
(engine 2.1.306). The fixes then turned them green.

| Finding | Fix | Test that proves it |
|---|---|---|
| F1 (major, and thread B7) | `captured` no longer reads a mark out of the text: `canonical` returns the questions it worded (text, mark, field) and an answer is paired by `q.question ===` that text. The mark read from the caller's text is the last one, not the first (the canonical text ends with it). | `S10` (failed before: the retry of A got fable/max), `S9` and `S9b` (a description holding `[ask zz:model]` no longer blocks the capture, and the canonical text sent back as written is the right question) |
| F2 | one question per (mark, field) | `S2` |
| F3 | `followUp` is stripped from the input like `answers`, and a result carrying `followUp` is not a choice | `S6`, `S6b` |
| F4 (and B10) | `review2.test.ts` R2 keys its answers by the canonical text and asserts `seen[0]` has no `answers`; R2b asserts none of `answers`, `annotations`, `response`, `afkTimeoutMs`, `followUp` reaches the dialog and has the nonce guard | `R2'` in `review3.test.ts`; mutants: `answers` removed from the stripped list gives 105 pass / 2 fail, the `delete input[k]` loop removed gives 103 pass / 4 fail (both survived before) |
| F6 | the dead link now points to the round 2 review comment | none (text) |
| B8 | a failure of `next` on the Agent call is caught inside `toolCalled`: the row is marked refused, the call is denied, `next` is not called a second time. A failure of `decide` goes to `askUser` so a row is always written. | `B8`; `ask.test.ts` "a fault beneath the mod ..." (was "goes to the ask path"; now checks the denial, `sent` empty, row `✗`) |
| B9 | a pinned call (fork, custom type) is sent on with `model` and `effort` unset; the row shows `inherited/default` and keeps `(asked ...)` | `B9`; `ask.test.ts` fork test updated |
| B11 | `types/index.d.ts` (`by: 'user'`, the Ask comment), README (pinned types, retry classified again not "refused", `fm-error`, the 2000-character cap is the whole brief, `followUp`, equality pairing), `fm.ts:7,14`, a comment in `register.tsx` | none (text) |
| C1 (Codex, `fm.ts:157`) | **not reproduced on 32cf9df.** `release` is chained on the call ahead (`void before.then(release)`), so a waiter that times out does not free the slot. | `C1` replays Codex's scenario (first call running, second times out, third arrives): `running` stays 1, peak 1, the third starts only after the first ends. It passes on the unchanged source (98 pass includes it); the older `fm.test.ts` test of the same property exists too. |

Left as it was (not in this round's list): the performance thread on the `asks` write per Agent call, the
`AskUserQuestion` fault path that resends the raw call (`.catch` for non-Agent calls goes to `next(e)`; nothing is
captured, so it fails safe), S7/S8 (design, liveness only).

## Gates after the fixes (real output, files in the session scratchpad)
Engine 2.1.306: `2.1.306 (Claude Code)`, `Validation passed`, 107 pass, 0 fail, Ran 107 tests across 12 files, exit 0.
Engine 2.1.312: `2.1.312 (Claude Code)`, `Validation passed`, 107 pass, 0 fail, Ran 107 tests across 12 files, exit 0.
tsc 5.6.3 with the 2.1.306 types (copy of the mod, types from another mod's `.claude-plugin/types` laid by 2.1.306): exit 0, no diagnostic.
No 2.1.312 types exist on disk, so tsc against them was not run.

## What stays unknown
Whether the real dialog keys `answers` by the text the mod rewrote (the test bench has no engine under `tool.call`); as
in rounds 1 and 2, only a live session shows it.
