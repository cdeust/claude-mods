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
a lookup, not a task), and what `main_allow` names. Plus, in `block` and `warn`, two calls the Stop reflection
hook needs and nothing else:

- `Read` of a file whose absolute path contains `/.claude/projects/`, then `/subagents/`, ends in `.jsonl` and has
  no `..` segment;
- `Bash` of exactly `python3 <script> --cwd <dir> lift <hex> --memory-id <digits>`, where `<script>` is
  `/Users/<user>/.claude/plugins/cache/.../tools/reflection_ledger.py` (or `/home/<user>/...`), `<dir>` is an absolute
  path, neither holds a `..` segment, and the whole command has none of `; & | ` $ ( ) < > ' " \ { } * ? [ ] ! # ~` or
  a line break anywhere in it.

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
