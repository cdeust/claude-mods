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

## Developing

Each mod is validated, tested and type-checked on its own:

```sh
cd mods/<mod> && claude plugin validate . && claude plugin test && npx -y -p typescript tsc -p .
```

`tsc` needs the engine to have loaded the mod once (it lays `.claude-plugin/types/`). For hot
reload in a session, link the mod into that session's `~/.claude/dev-mods/<session>/` folder;
the engine watches the folder a link names.

## Installing

A folder marketplace reads the mods from this checkout, with no copy:
`claude plugin marketplace add <this folder>` once `.claude-plugin/marketplace.json` lists each
mod as `"source": "./mods/<mod>"`, then `/plugin install <mod>` and `/reload-plugins` after an edit.
