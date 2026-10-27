# delegate

The main loop only delegates; every delegation names the model and the effort its task needs. The mod does
three things:

1. **Routes** an `Agent` call that leaves the model or the effort out. A model or an effort the call names is
   never touched; a `fork` and a custom subagent type (a plugin's agent, which pins its own model) are left alone.
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
| `main_allow` | empty | Comma-separated tool names the main loop keeps besides the orchestration tools; a trailing `*` matches a prefix (`mcp__my_server__*`). |

To turn the guard off: `main_mode` = `off`. To remove the mod: `/plugin uninstall delegate`.

## What the main loop keeps

The orchestration tools (`Agent`, `SendMessage`, `AskUserQuestion`, `Skill`, `ToolSearch`, `TaskStop`, the task
and plan tools, scheduling and notification tools), the Cortex and zetetic memory servers (`recall`, `remember`:
a lookup, not a task), and what `main_allow` names. Plus, in `block` and `warn`, four calls the Stop reflection
hook needs and nothing else:

- `Read` of a subagent transcript: exactly `$HOME/.claude/projects/<project>/<session>/subagents/<name>.jsonl`,
  where `$HOME` is the engine's own `HOME` and each segment is letters, digits, `_`, `-` and `.`, not starting with
  `.` (so no `..`, `.`, `//` or space). On disk (the engine's `fs.stat`) it must be a regular file, not a link and
  not a directory, and land at that same place under the real `$HOME/.claude/projects`, so no folder below it is a
  link either. If `HOME` is unset or a stat fails, the call is refused;
- `Bash` of exactly `python3 <script> --cwd <dir> lift <hex> --memory-id <digits>`, where `<script>` is
  `/Users/<user>/.claude/plugins/cache/.../tools/reflection_ledger.py` (or `/home/<user>/...`) and `<dir>` is an
  absolute path, neither with a `..` segment;
- `Bash` of exactly `python3 <script> --cwd <dir> list` (same script and `--cwd` rules; it only prints the pending
  reflections);
- `Bash` of one `grep [flags] [-e PATTERN | PATTERN] FILE...`: flags are clusters of `c o E F i n h H`, `-m <1-10>`
  and `-A|-B|-C <0-2>`; a grep that prints lines must carry `-m` (`-c`, one count a file, need not); 1 to 5 `FILE`s,
  each a transcript as defined above, shape and disk; the pattern is a plain word of letters, digits and
  `_ . : = , @ % + / -`, starting with neither `-` nor `=`. No `-r`, no `-f`, no other option or command.

Every `Bash` command above is checked as the shell will split it: words of printable ASCII separated by one space,
with no tab, newline, other control character, non-ASCII character, or leading, trailing or double space, and none
of `; & | ` $ ( ) < > ' " \ { } * ? [ ] ! # ~ ^`. zsh and bash split words on space, tab and newline only (every
character from 0x01 to 0x7f and the Unicode spaces were checked, with the Claude Code shell snapshot sourced), so
the words the guard checks are the argv the shell builds. `^` is refused because a user's zsh may have
`EXTENDED_GLOB` on, under which a word `^x` lists the working folder; a pattern starting with `=` because zsh
replaces such a word with a command's path.

The built-in `Grep` tool is not exempted. The `Bash` grep stays the one way: a second accepted shape would only add
to what the main loop may run.

## Routing table

The task is read from the call's `description`, else the first 300 characters of its `prompt` (English and French
stems, matched at the start of a word). First match wins.

| Task | Model | Effort |
|---|---|---|
| `Explore` | haiku | low (medium when the prompt says "very thorough") |
| `claude-code-guide`, `statusline-setup` | haiku | low |
| `Plan` | opus | high |
| review, audit, security, threat, architecture, design, plan, critical | opus | high |
| implement, fix, refactor, write, edit, add, migrate, test, debug, build, create, update, rename, port | sonnet | medium |
| search, find, locate, list, grep, explore, map, read, crawl, scrape, fetch, web, look up, survey, inventory, check, inspect, summarize | haiku | low |
| anything else | sonnet | medium |

## Limits

- The recorded `ran` model and effort are what the engine sent at the agent's first step, as the hook saw them. The
  mod rewrites no step, so this is the engine's own decision, not a request the mod made.
- The pane keeps the last 30 delegations. The first step of an agent that arrives before its spawn is answered
  is held in memory for the row; a hot reload loses it and the pane then shows `?`.
- The main-loop guard is a refusal at `tool.call`. It does not change permission prompts, and it does not stop a
  subagent from doing what the main loop may not. A hook of the mod that fails lets the call go on as if the mod
  were absent (`.catch` fails open).
- The transcript check reads the disk when the call is made, not when the tool opens the file: a file swapped in
  between (only something other than the main loop can write there) is not seen. A hard link keeps its own path and
  is not seen either. A link at or above `$HOME/.claude/projects` is the owner's and is followed.
- A `HOME` with a character outside printable ASCII makes every transcript `grep` refused (a `Read` still passes), and
  a `--cwd` outside printable ASCII makes `lift` and `list` refused. Transcripts under a `CLAUDE_CONFIG_DIR` other
  than `~/.claude` are refused. Another mod whose `fs.stat` hook refuses the stat makes the transcript calls refused.
- A grep's output is bounded in lines and files, not bytes: a transcript line is one message (4.6 KB on average, up
  to 719 KB measured), so `-m 10` can still print megabytes. A `Read` of the same transcript is already allowed, so
  this is context cost, not disclosure.
- Mods in this repository: this is the only one. Others come back later, one at a time.

## Developing

```sh
claude plugin validate mods/delegate
claude plugin test mods/delegate
cd mods/delegate && npx -y -p typescript@5.6.3 tsc -p . --noEmit
```

`tsc` needs the engine to have loaded the mod once (it lays `.claude-plugin/types/`, which is git-ignored); keep
`--noEmit`.
