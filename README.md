# claude-mods

Claude Code mods for the ai-architect.tools harness, one concern per mod, state shared through
`dependencies`:

| Mod | Owns | Depends on |
|---|---|---|
| `cortex-guard` | `refusals`: wiki pages only through `wiki_write`, worktrees inside `<repo>/.claude/worktrees/` | nothing |
| `cortex-wiki` | `/wiki <wiki/**.md>` to PDF | nothing |
| `zetetic-genius` | `state`: the request grade (task class → effort), the genius patterns and skills it matches | nothing |
| `zetetic-autopilot` | `context`, `policy`: effort ladder, model routing, pressure, lean results | `zetetic-genius` |
| `cortex-cockpit` | `stats`, `ledger`, `tally`, `stages`, `hygiene`; the `/cortex` pane draws the rest | the three above |
| `harness-fleet` | `fleet`: the owner's plugins, installed vs offered version, open PRs with CI, issue counts; `/fleet`. Reads only (`gh pr list`, `gh issue list`, `git remote`): every outward action is a button the owner presses, which puts a prompt in front of the model | guard, genius, autopilot |

## Developing

Each mod is validated, tested and type-checked on its own:

```sh
cd mods/<mod> && claude plugin validate . && claude plugin test && npx -y -p typescript tsc -p .
```

`tsc` needs the engine to have loaded the mod once (it lays `.claude-plugin/types/`). For hot
reload in a session, link the mod into that session's `~/.claude/dev-mods/<session>/` folder;
the engine watches the folder a link names.

## Installing

`.claude-plugin/marketplace.json` lists each mod as `"source": "./mods/<mod>"`, so the repository
is the marketplace. From another machine:

```sh
/plugin install <mod> --marketplace cdeust/claude-mods
```

`y` adds the marketplace, then the user scope. On this machine a folder marketplace reads the
mods from the checkout, with no copy: `claude plugin marketplace add <this folder>`, then
`/plugin install <mod>` and `/reload-plugins` after an edit.
