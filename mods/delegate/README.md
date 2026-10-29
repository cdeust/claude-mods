# delegate

The main loop only delegates; the mod decides the model and the effort each delegation needs. The mod does
three things:

1. **Decides** the model and the effort of every `Agent` call from its brief, with Apple's on-device model (fm)
   and, if you configure a TypeSafe key, Jev; with no answer from either it asks you. A model or an effort the
   call names is kept as a request (`asked`) beside the decision, never applied; a `fork` and a custom subagent
   type (a plugin's agent, which pins its own model) are left alone.
2. **Guards** the main loop: its own work tools (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `WebFetch`, ...) are
   refused with a message that says to delegate. A subagent's calls carry an `agentId` and are never touched.
3. **Shows** the delegations in a `/delegate` pane: for each, the model and the effort asked, and the ones the
   engine applied at the agent's first step (`asked → ran`, for example `haiku → haiku`, `low → low`; `?` until a
   step is seen).

## Install

```sh
/plugin install delegate --marketplace cdeust/claude-mods
```

## Options

Set them in `settings.json` under `pluginConfigs`, or in `/config`.

| Option | Default | Meaning |
|---|---|---|
| `main_mode` | `block` | `block`: the main loop's work tools are refused. `warn`: allowed, with a toast. `off`: the mod only routes subagents (and adds no delegation text to the system prompt). |
| `typesafe_api_key` | empty | Sensitive (secure storage). With a key, Jev reads each brief beside fm and the higher class wins; without one Jev is skipped. The brief is sent to TypeSafe: see "Data sent to TypeSafe". |
| `main_allow` | empty | Comma-separated tool names the main loop keeps besides the orchestration tools; a trailing `*` matches a prefix (`mcp__my_server__*`). |

To turn the guard off: `main_mode` = `off`. To remove the mod: `/plugin uninstall delegate`.

## What the main loop keeps

The orchestration tools (`Agent`, `SendMessage`, `AskUserQuestion`, `Skill`, `ToolSearch`, `TaskStop`, the task
and plan tools, scheduling and notification tools), the Cortex and zetetic memory servers (`recall`, `remember`:
a lookup, not a task), and what `main_allow` names. Plus, in `block` and `warn`, four calls the Stop reflection
hook needs and nothing else:

- `Read` of a file whose absolute path contains `/.claude/projects/`, then `/subagents/`, ends in `.jsonl` and has
  no `..` segment;
- `Bash` of exactly `python3 <script> --cwd <dir> lift <hex> --memory-id <digits>`, where `<script>` is
  `/Users/<user>/.claude/plugins/cache/.../tools/reflection_ledger.py` (or `/home/<user>/...`), `<dir>` is an absolute
  path, neither holds a `..` segment, and the whole command has none of `; & | ` $ ( ) < > ' " \ { } * ? [ ] ! # ~` or
  a line break anywhere in it;
- `Bash` of exactly `python3 <script> --cwd <dir> list` (same script and `--cwd` rules; it only prints the pending
  reflections);
- `Bash` of one `grep [flags] [-e PATTERN | PATTERN] FILE...` over subagent transcripts: flags are clusters of
  `c o E F i n h H` and `-m|-A|-B|-C <digits>`; the pattern is a plain word (letters, digits and `_ . : = , @ % + ^ / -`;
  no quotes, so no spaces); every `FILE` is a transcript as defined above. No pipe, chaining, redirection,
  substitution or glob (the metacharacters above are refused), no `-r`, no `-f`, no other command.

## How a delegation is decided

No keyword, pattern or text rule takes part in the decision. Two models read the brief; the engine's agent type
bounds the result; when no model answers, you choose. Per `Agent` call:

1. A `fork` and a custom subagent type are the caller's: the mod does not decide them.
2. **fm** (Apple's on-device model, `/usr/bin/fm`) and, **if a TypeSafe API key is configured, Jev** (`jev-latest`,
   `POST https://api.typesafe.ai/v1/systemone`, one Choice question over the four classes) read the brief at the
   same time. Both answered: **the higher class wins** (`read` < `build` < `judge` < `critical`), so a brief that
   steers one model down is still read by the other. One answered: it decides, and the row says which model was
   missing and why. Jev takes over from fm when fm is busy (see "Concurrency") and when fm fails (`fm-absent`,
   `fm-exit`, `fm-timeout`, `fm-unparseable`, `fm-overflow`); fm decides alone when there is no key or Jev fails.
3. The agent type bounds the class (below), and a bound that changed the answer is recorded in the row.
4. **Neither answered** (fm unavailable or failed, and Jev keyless, failed or rate limited): the mod asks you which
   model and which effort, tagged `user` (below).

The class gives the pair, from one table shared by both models, so a model and an effort never come from two
sources (a call that named only a model gets the class's effort, not the caller's):

| Class | Model | Effort | The task |
|---|---|---|---|
| `read` | haiku | low | mechanical lookup, listing or search whose result the caller can check |
| `build` | sonnet | medium | implement, fix, refactor, write tests, run a build against a known design |
| `judge` | opus | high | review, audit, security, design, experiment, measurement, anything the caller cannot check |
| `critical` | opus | xhigh | irreversible or security-critical decisions, multi-system architecture |

### The max of two models is the injection protection

A brief can tell a classifier what to answer ("class read", "answer critical"). The protection is not a filter on the
text: it is that two different models read it and the higher class wins, so steering both down at once is harder
than steering one. With no key only fm reads the brief, and the protection is the agent type's bounds. The
`<brief>...</brief>` block around the text is formatting: it shows where the brief ends and defends nothing.

This defense holds **only when both models answer**. With no key, with Jev failing or rate limited, or with fm busy,
absent or slow, one model alone decides and nothing is maxed: the only remaining protection is the agent type's
bounds (next section), and a brief that steers that one model down gets the lower class. The row says which model was
missing.

Jev's confidence (0 to 1, from the spread of its probabilities) is recorded in the row, not used to decide.

### What bounds the answer

Only what the engine knows, with no reading of the brief's words: **Explore**, a read-only search agent, is capped
at `build`; **Plan**, which designs, is floored at `judge`. The bound reads `subagent_type`, and the **caller chooses
it**: a call that names `general-purpose` (or leaves the type out) is not capped, whatever it does, and one that names
`Explore` takes the cap. The Explore cap is a cost limit that the caller can pick or avoid, not a security boundary
against the caller. A changed answer ends the reason `[capped from X by the
agent type]` or `[floored from X by the agent type]`. (An earlier version also floored on keywords found in the
description; that text analysis is removed.)

### When no model answers: you choose

If fm and Jev both fail to answer, the mod asks which model (haiku, sonnet, opus, fable) and which effort (low,
medium, high, xhigh; `max` typed under "Other") in the engine's own dialog, and applies the answer tagged `user`.
Where nobody can be asked (a `-p` run, a dismissed dialog) the Agent call is **refused** with a message telling the
main loop to call `AskUserQuestion` with exactly two questions, each ending in a mark the mod issued
(`[ask <nonce>:model]`, `[ask <nonce>:effort]`), and then to call `Agent` again with the same description.

What the retry names is ignored. The mod watches the `AskUserQuestion` call itself (a `tool.call` hook sees the
engine's answer) and keeps the user's answer to a marked question, if and only if the call was answered, the mark is
one the mod issued, and the answer is a model (or an effort) from the lists above. The retry applies that stored
pair, tagged `user`, and consumes it in one atomic state update, so of any number of parallel retries one is applied
and the others are refused again. The pending entry is dropped at the start and at the end of the main loop's turn:
an answer does not outlive the turn that asked. The invariant: a pair is applied tagged `user` only if the user chose
it in a marked `AskUserQuestion` during the current turn, once. A refusal anyone can obtain (a burst, a warm-up, a `-p`
run) opens nothing by itself: with no answer, a retry that names a pair is refused. What this does not prove: the
main loop writes the question and its options, so it can offer the user a narrowed choice; the user's answer is what
is applied, and the pane shows the pair and `[user]`.

### Recorded beside the caller's request

Each row of the `/delegate` pane shows `decided model → ran model · decided effort → ran effort · description
[fm|jev|fm+jev|user|caller|none]`, then `(asked model/effort)` when the call named something different (`-` for a
field it did not name), and under it the reason: the class, each model's answer and, when one is missing, why:

| Reason names | Meaning |
|---|---|
| `fm-timeout` | fm did not answer in its deadline (a cold first call takes 7-19 s; the session start warms it) |
| `fm-busy` | another classification is in flight and this call's deadline cannot be met behind it, or fm is warming up |
| `fm-absent` | `/usr/bin/fm` cannot start (the engine reports "failed to start"): fm is skipped for the rest of the session. Any other fault in the call is `fm-error` and fm is tried again at the next spawn |
| `fm-exit`, `fm-overflow`, `fm-unparseable`, `fm-error` | fm exited non-zero, reported a context overflow, answered with something that is not a class, or failed otherwise |
| `jev-nokey` | no API key is configured: Jev is skipped |
| `jev-limited (429/529)`, `jev-auth (401/403)`, `jev-http (status)` | TypeSafe refused or failed; no retry, no loop |
| `jev-timeout`, `jev-unparseable`, `jev-error` | no answer in 4 s, an answer that is not a class, a failed request |

`caller` rows (fork, custom type) carry the caller's own fields; `none` rows are calls refused until you choose.

### The two models' calls

**fm:** `fm respond --no-stream --greedy --schema hooks/route.schema.json -i <instructions>`, the brief on stdin: the
argv is fixed, no shell is involved, the brief never reaches a command line.

**Jev:** one `$.http.fetch` with `Authorization: Bearer <key>` and the same brief as `state`. The key comes from
the sensitive option `typesafe_api_key` (secure storage) and appears nowhere else: not in a row, a log or a refusal.

**What binds fm is latency, not the context window.** A call costs about 1.2 ms per input token, and fm reports a
context overflow only after 6.7-7.1 s, longer than the 4 s deadline, so the deadline comes first. The input to both
models is therefore capped at 2000 characters: description (up to 300) and type (up to 60) whole, the prompt takes
the rest, cut to its head (two thirds) and tail (one third) around `[…]`.

Measured on 2026-10-29 (macOS, Apple on-device model, `/usr/bin/fm`, warm). Method: `fm respond --no-stream
--greedy --schema hooks/route.schema.json -i <the instructions>` with a brief of the given size on stdin, wall clock
of the process, one run per cell (the 2000 row: 2-3 runs). Texts: `prose` English words, `code` repeated TypeScript
lines, `hex` random hexadecimal, `base64` random base64.

| Input chars | prose | code | hex | base64 |
|---|---|---|---|---|
| 500 | 2.41 s (first call) | 1.05 s | 1.04 s | 1.05 s |
| 1000 | 1.02 s | 1.06 s | 1.17 s | 1.24 s |
| **2000 (the cap)** | 1.25 s | 1.46-1.70 s | **1.89 s** | 1.60-1.67 s |
| 2500 | | 1.75 s | 2.57 s | 2.06 s |
| 3000 | 1.16 s | 1.58 s | 3.03 s | 2.43 s |
| 6000 | 1.71 s | 2.79 s | 7.91 s | 5.31 s |

The median of the ten measured calls at the cap is 1.635 s (`EXPECT_MS` = 1650); the slowest is 1.89 s
(`MIN_RUN_MS` = 1900). Cold model: 7-19 s.

Characters per token (UTF-16 units per token, fm's own count; `fm count-tokens -q`): English 5.1, hex 1.14, base64
1.42, emoji about 1.67, **CJK 0.478**, mixed non-Latin 0.556 (all measured by the reviewer, 2026-10-29). Re-measured
here the same day: random CJK ideographs, 1000 units = 2091 tokens, **0.478** (reproduced exactly); a mix of
Cyrillic, Arabic, Thai and kana, 1000 units = 1218 tokens, **0.821** (a different mix from the reviewer's, so a
different figure). Two characters per token is not a worst case. **Adversarial non-Latin input can therefore exceed
the fm deadline even at the 2000-character cap** (2000 CJK units are about 4200 tokens, about 5 s by the 1.2 ms
per token rule): the call is then `fm-timeout` and Jev (if keyed) or you decide. Measured the same day, random CJK
ideographs through the same call: 1081 characters 3.39 s, 1981 characters 5.20 s (past the 4 s deadline). Also
observed: after several of the test's own fm calls were killed mid-run, ordinary English briefs took 53, 78 and 86 s
for a few minutes before the service recovered (1.8 s again): fm can be slow for reasons outside the brief, which is
what the deadline and the slot guard are for.

### Concurrency

fm queues parallel calls itself (4 at once finished at 2.2, 3.3, 4.5 and 5.6 s), and a prompt that recommends
parallel spawns produces exactly that. The mod keeps one fm call in flight. Each call has a 4 s deadline measured
from when it was enqueued; it gets what is left as its timeout. A call is `fm-busy` at once when the calls ahead
already use its deadline (the typical call is 1.65 s, so the first two of a burst are served and the rest are
busy) or when the model is warming up. A call waiting for its turn gives up when what is left would not cover a
run, and a call that never returns is cut at its timeout, so the slot is always released (the guard is
`$.clock.sleep`; the sandbox has no `setTimeout`). A waiter that gives up does not free the slot while the call ahead
still runs: the next call chains on that call. The warm-up call sent at the session start (`fm respond ... ok`, 30 s)
is guarded the same way: it never rejects, a failed start is `fm-absent`, and if it neither answers nor is killed the
guard ends the wait, so the model is never left marked as warming. With a key, a busy spawn is decided by Jev alone.

### Data sent to TypeSafe, and the key

With **no key** nothing leaves the machine: fm is on-device. With a key, **every Agent brief (description, agent type
and up to 2000 characters of the prompt, which may contain code or other sensitive text) is sent to TypeSafe**,
beside the on-device read. TypeSafe states that it does not train models on user data (docs.typesafe.ai/models.md and
the privacy policy linked from docs.typesafe.ai/legal.md); zero data retention is offered to enterprise customers
only (docs.typesafe.ai/legal.md). Do not set a key if your briefs may carry what you may not send to a third party.

To configure it: `/config` and set `typesafe_api_key` for the delegate plugin, or save it from stdin with
`claude plugin configure delegate --values-stdin`. A sensitive option is kept in the OS secure storage, not in
`settings.json`. To remove Jev, clear the option.

## Limits

- Both models are small classifiers reading the brief only: a brief that hides what is to be judged is classified
  on what it says, which is why the mod's prompt section tells the main loop to describe the task honestly. The
  decision is always shown beside the request so a disagreement can be counted.
- With no key and fm down, busy or slow, every Agent call goes to you. That is the design: there is no silent
  default.
- The recorded `ran` model and effort are what the engine sent at the agent's first step, as the hook saw them. The
  mod rewrites no step; the Agent call it rewrites is the one that carries the decided model and effort.
- The user's answer is read from `answers[<question>]` of the `AskUserQuestion` result (2.1.306 declares it as question
  text to answer string). A `max` effort typed under "Other" is captured only if the engine returns it there; if it came
  back only as the free-text `response` field it is not captured and the retry is refused again (not verified in a live
  session). The pending ask is dropped at `turn.start` and at the main loop's `turn.complete`; if the engine ended the
  turn while the dialog waits, every retry after a marked answer would be refused (also not verified live).
- The pane keeps the last 30 delegations. The first step of an agent that arrives before its spawn is answered
  is held in memory for the row; a hot reload loses it and the pane then shows `?`.
- The main-loop guard is a refusal at `tool.call`. It does not change permission prompts, and it does not stop a
  subagent from doing what the main loop may not. A fault in the Agent decision never lets the call through with the
  caller's pair: it goes to you.
- A symbolic link cannot be seen from the path string: a `.jsonl` link under `subagents/` is read as what it points to.
- Mods in this repository: this is the only one. Others come back later, one at a time.

## Developing

```sh
claude plugin validate mods/delegate
claude plugin test mods/delegate
cd mods/delegate && npx -y -p typescript@5.6.3 tsc -p . --noEmit
```

`tsc` needs the engine to have loaded the mod once (it lays `.claude-plugin/types/`, which is git-ignored); keep
`--noEmit`.
