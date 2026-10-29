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
| `critical` | opus | xhigh | irreversible or security-critical decisions, multi-system architecture (`fm` only; the keywords never answer it) |

Keyword rules (English and French stems, matched at the start of a word, on the `description` else the first 300
characters of the `prompt`; first match wins): `Explore`, `claude-code-guide`, `statusline-setup` are `read`;
`Plan` is `judge`; review, audit, security, threat, architecture, design, plan, critical, experiment, measure,
benchmark are `judge`; implement, fix, refactor, write, edit, add, migrate, test, debug, build, create, update,
rename, port are `build`; search, find, locate, list, grep, explore, map, read, crawl, scrape, fetch, web, look up,
survey, inventory, check, inspect, summarize are `read`; anything else is `build` (tagged `default`).

### Recorded beside the caller's request

Each row of the `/delegate` pane shows `decided model → ran model · decided effort → ran effort · description
[fm|regex|default|caller]`, then `(asked model/effort)` when the call named something different (`-` for a field it
did not name), and under it the reason: the class and the model's short reason, or the fallback reason:

| Reason starts with | Meaning |
|---|---|
| `fm-timeout` | `fm` did not answer in 4 s (a cold first call takes 7-19 s; the session start warms it) |
| `fm-absent` | `/usr/bin/fm` cannot start (or the engine has no `$.process`): the regex decides for the rest of the session |
| `fm-exit` | `fm` exited non-zero for a reason other than context size |
| `fm-overflow` | the brief overflowed the context twice, at the budget and at half of it |
| `fm-unparseable` | `fm` exited 0 but its output was not a JSON object with a known class |
| `fm-error` | anything else went wrong in the mod around the call |
| `classifier=regex` | the option is set to `regex` |

`caller` rows (fork, custom type) carry the caller's own fields, or `inherited` / `default` when it named none.

### The classifier call

`fm respond --no-stream --greedy --schema hooks/route.schema.json -i <instructions>`, the brief on stdin: the argv
is fixed, no shell is involved, the brief never reaches a command line. The schema (an enum of the four classes plus
a short reason) is shipped in the mod. Measured on 2026-10-29 (macOS, Apple on-device model, `fm` at `/usr/bin/fm`):

| What | Number | How |
|---|---|---|
| Warm latency, bare prompt | 0.56-0.74 s | repeated `fm respond --no-stream --greedy` calls after a first |
| Latency, with instructions and schema | 1.1-3.1 s wall (4 briefs) | `fm respond --schema ... -i ...`, one brief each |
| Cold first call | 7-19 s | first call after the model was idle |
| Context limit | ~8125 fm tokens, instructions included | bisection on briefs of growing size until `exit 1` |
| Characters per token | ~2 (20,001 characters of English filler = 9,783 tokens) | the worst case; the budget assumes it |
| Overflow signal | exit 1, stderr `Error: The session's transcript exceeded the model's context size.` | a 35,363-character brief of random numbers, reproduced with this schema and these instructions |

The brief's character budget is `(8125 - 256 response reserve - 200 safety) tokens * 2 chars/token - the instructions'
length`. A longer brief is cut to the budget keeping its head (two thirds) and its tail (one third) around `[…]`.
On the overflow error the budget is halved and the call retried once; the smaller budget is learned and stored in
the mod's state, where it only shrinks.

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
