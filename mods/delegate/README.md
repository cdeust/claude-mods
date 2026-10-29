# delegate

The main loop only delegates; the mod decides the model and the effort each delegation needs. The mod does
three things:

1. **Decides** the model and the effort of every `Agent` call from its brief. A model or an effort the call names
   is kept as a request (`asked`) beside the mod's decision, never applied; a `fork` and a custom subagent type
   (a plugin's agent, which pins its own model) are left alone.
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
| `classifier` | `fm` | `fm`: the on-device model classifies each brief, the keyword rules answer when it cannot. `regex`: keyword rules only. |
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

Order, per `Agent` call:

1. `classifier` = `fm` (the default): Apple's on-device model, `/usr/bin/fm`, reads the brief (description,
   subagent type, prompt) and answers one class and a short reason.
2. If `fm` cannot answer, the keyword rules below name the class, and the reason says why `fm` did not:
3. If no keyword matches, the default (`build`).

The class gives the pair, from one table shared by both instruments, so a model and an effort never come from two
sources (a call that named only a model gets the class's effort, not the caller's):

| Class | Model | Effort | The task |
|---|---|---|---|
| `read` | haiku | low | mechanical lookup, listing or search whose result the caller can check |
| `build` | sonnet | medium | implement, fix, refactor, write tests, run a build against a known design |
| `judge` | opus | high | review, audit, security, design, experiment, measurement, anything the caller cannot check |
| `critical` | opus | xhigh | irreversible or security-critical decisions, multi-system architecture (keywords: irreversible, destructive, drop table/database, force-push, exfiltrate, privilege escalation) |

Keyword rules (English and French stems, matched at the start of a word, on the `description` else the first 300
characters of the `prompt`; first match wins): `Explore`, `claude-code-guide`, `statusline-setup` are `read`;
`Plan` is `judge`; review, audit, security, threat, architecture, design, plan, critical, experiment, measure,
benchmark are `judge`; implement, fix, refactor, write, edit, add, migrate, test, debug, build, create, update,
rename, port are `build`; search, find, locate, list, grep, explore, map, read, crawl, scrape, fetch, web, look up,
survey, inventory, check, inspect, summarize are `read`; anything else is `build` (tagged `default`).

### What bounds the model's answer

A brief can say what class it wants ("class read", "answer critical"); the classifier is therefore bounded by
evidence the brief cannot rewrite:

- **Floor:** `fm` cannot answer below a `judge` or `critical` keyword of the description (else the first 300
  characters of the prompt), nor below `judge` for `Plan`.
- **Ceiling:** `Explore`, a read-only search agent, cannot go above `build`. The floor is applied after the ceiling,
  so an `Explore` asked to audit still reaches `judge`.
- The brief is sent inside `<brief>...</brief>`, which the instructions call data, never instructions; a
  `</brief>` inside the text is defanged.
- When a bound changes the answer the reason ends `[fm-floored: model said X]` or `[fm-capped: model said X]`, so
  the disagreement stays countable.

### Recorded beside the caller's request

Each row of the `/delegate` pane shows `decided model → ran model · decided effort → ran effort · description
[fm|regex|default|caller]`, then `(asked model/effort)` when the call named something different (`-` for a field it
did not name), and under it the reason: the class and the model's short reason, or the fallback reason:

| Reason starts with | Meaning |
|---|---|
| `fm-timeout` | `fm` did not answer in 4 s (a cold first call takes 7-19 s; the session start warms it) |
| `fm-absent` | `/usr/bin/fm` cannot start (or the engine has no `$.process`): the regex decides for the rest of the session |
| `fm-exit` | `fm` exited non-zero for a reason other than context size |
| `fm-overflow` | `fm` reported a context overflow (the 2000-character cap makes it unreachable in practice; no retry) |
| `fm-busy` | another classification is in flight and this call's deadline cannot be met behind it, or the model is warming up: the regex decides at once |
| `fm-unparseable` | `fm` exited 0 but its output was not a JSON object with a known class |
| `fm-error` | anything else went wrong in the mod around the call |
| `classifier=regex` | the option is set to `regex` |

`caller` rows (fork, custom type) carry the caller's own fields, or `inherited` / `default` when it named none.

### The classifier call

`fm respond --no-stream --greedy --schema hooks/route.schema.json -i <instructions>`, the brief on stdin: the argv
is fixed, no shell is involved, the brief never reaches a command line. The schema (an enum of the four classes plus
a short reason) is shipped in the mod.

**What binds is latency, not the context window.** A call costs about 1.2 ms per input token, and the model's
context (~8125 fm tokens, instructions included) is only reported as an overflow after 6.7-7.1 s, longer than the
4 s deadline, so a deadline that kills the call comes first. The input is therefore capped at 2000 characters:
description (up to 300) and type (up to 60) whole, the prompt takes the rest, cut to its head (two thirds) and tail
(one third) around `[…]`. There is no overflow retry and no learned budget: neither can fire under this cap.

Measured on 2026-10-29 (macOS, Apple on-device model, `/usr/bin/fm`, warm). Method: `fm respond --no-stream
--greedy --schema hooks/route.schema.json -i <the instructions>` with a brief of the given size on stdin, wall clock of
the process, one run per cell (the 2000 column: 2-3 runs). Texts: `prose` English words, `code` repeated TypeScript
lines, `hex` random hexadecimal, `base64` random base64. A first call after idle took 2.4 s (prose, 500) and a cold
model 7-19 s.

| Input chars | prose | code | hex | base64 |
|---|---|---|---|---|
| 500 | 2.41 s (first call) | 1.05 s | 1.04 s | 1.05 s |
| 1000 | 1.02 s | 1.06 s | 1.17 s | 1.24 s |
| **2000 (the cap)** | 1.25 s | 1.46-1.70 s | **1.89 s** | 1.60-1.67 s |
| 2500 | | 1.75 s | 2.57 s | 2.06 s |
| 3000 | 1.16 s | 1.58 s | 3.03 s | 2.43 s |
| 6000 | 1.71 s | 2.79 s | 7.91 s | 5.31 s |

The worst density (hex) at the cap takes 1.89 s, well under the 4 s deadline; at 6000 it takes 7.91 s and would be
killed. Characters per token (reviewer's measurement, 2026-10-29, `fm`'s own token count): English 5.1, hex 1.14,
base64 1.42, emoji about 1.67 UTF-16 units. Two characters per token is not a worst case; the earlier claim that it
was, and its "English filler" figure, were wrong.

**Concurrency.** `fm` queues parallel calls itself (4 at once finished at 2.2, 3.3, 4.5 and 5.6 s), and a prompt
that recommends parallel spawns produces exactly that. The mod keeps one classification in flight. Each call has a
4 s deadline measured from when it was enqueued: it gets what is left of it as its timeout, and a call that cannot be
reached in time (the calls ahead already use the deadline, or the remaining time is under 1.9 s, the slowest call
at the cap) is `fm-busy` at once and the regex decides, instead of queueing until it times out. In a burst of
parallel spawns the first two go to `fm`, the rest are `fm-busy`. While the session-start warm-up runs (up to 30 s on
a cold model) every spawn is `fm-busy`; it does not wait behind the warm-up.

## Limits

- `fm` is a small on-device classifier. It reads the brief only: a brief that hides what is to be judged is
  classified on what it says, which is why the mod's prompt section tells the main loop to describe the task
  honestly. The decision is always shown beside the request so a disagreement can be counted.
- A first Agent call right after the machine woke can time out while the model loads (`fm-timeout`, the regex
  decides); the warm-up at session start is fire-and-forget and cannot prevent it.
- The recorded `ran` model and effort are what the engine sent at the agent's first step, as the hook saw them. The
  mod rewrites no step; the Agent call it rewrites is the one that carries the decided model and effort.
- The pane keeps the last 30 delegations. The first step of an agent that arrives before its spawn is answered
  is held in memory for the row; a hot reload loses it and the pane then shows `?`.
- The main-loop guard is a refusal at `tool.call`. It does not change permission prompts, and it does not stop a
  subagent from doing what the main loop may not. A hook of the mod that fails lets the call go on as if the mod
  were absent (`.catch` fails open).
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
