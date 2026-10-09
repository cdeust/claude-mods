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
| `harness-fleet` | `fleet`: the owner's plugins, installed vs offered version, open PRs with CI, open issues (a defect is taken and fixed, a feature request goes to the owner); `/fleet`. Reads only (`gh pr list`, `gh issue list`, `git remote`): every outward action is a button the owner presses, which puts a prompt in front of the model | guard, genius, autopilot |

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

## Without write access to settings.json

`claude plugin marketplace add` and `claude plugin install` both write `enabledPlugins` and
`extraKnownMarketplaces` into `settings.json`. Where that file cannot be changed, load the mods by
directory instead: nothing is written, and each mod is registered for the session as `<name>@inline`.

```sh
MODS=/path/to/claude-mods/mods

# repeat --plugin-dir once per mod
claude \
  --plugin-dir $MODS/cortex-guard \
  --plugin-dir $MODS/cortex-wiki \
  --plugin-dir $MODS/zetetic-genius \
  --plugin-dir $MODS/zetetic-autopilot \
  --plugin-dir $MODS/cortex-cockpit \
  --plugin-dir $MODS/harness-fleet

# or one variable, colon separated
CLAUDE_CODE_PLUGIN_DIRS=$MODS/cortex-guard:$MODS/cortex-wiki:$MODS/zetetic-genius:$MODS/zetetic-autopilot:$MODS/cortex-cockpit:$MODS/harness-fleet claude

# an alias in the shell profile
alias claude-mods='CLAUDE_CODE_PLUGIN_DIRS=$MODS/cortex-guard:$MODS/cortex-wiki:$MODS/zetetic-genius:$MODS/zetetic-autopilot:$MODS/cortex-cockpit:$MODS/harness-fleet claude'
```

`claude plugin list` shows them under "Session-only plugins" with `Status: loaded`.

What then must hold:

- The `dependencies` of a mod are resolved among the mods loaded in the same command, so load a
  mod together with what it names: `zetetic-autopilot` needs `zetetic-genius`; `cortex-cockpit`
  needs `cortex-guard`, `zetetic-autopilot` and `zetetic-genius`; `harness-fleet` needs the same
  three. A mod whose dependency is absent is listed `disabled`, with the error
  `Dependency "<name>" is not installed`.
- Options cannot be set (they live in `settings.json` under `pluginConfigs`), so every default in a
  `plugin.json` has to be right on any machine:

| Mod | Option | Default | Notes |
|---|---|---|---|
| `cortex-guard` | `hygiene_script` | `~/Developments/disk-hygiene/disk_hygiene.py` | `~/` is the home of the user running the session, read at runtime. When the file is not there, one toast per session says `hygiene script not found at <path>; worktrees are not registered`; an empty value disables the registration without a toast |
| `zetetic-genius` | `mode`, `classifier_model` | `observe`, `haiku` | the grade is one low-effort completion on the `haiku` alias |
| `zetetic-autopilot` | `policy_mode` | `enforce` | |
| `cortex-cockpit` | `surface`, `cortex_server` | `ink`, `plugin_hypermnesia-mcp_cortex` | the server name as `/mcp` lists it |
| `harness-fleet` | `github_owner`, `refresh_on_start` | `cdeust`, `true` | reads `gh pr list`, `gh issue list` and `git remote` |

- The machine must let the mods do what they ask: `python3` (guard), the Cortex MCP server by
  name (cockpit), `gh` and a route to `api.github.com` (fleet), the files under `~/.claude/plugins/`
  (fleet), `pandoc` and `xelatex` (wiki), and the model aliases (genius, autopilot).

`/cortex check` tests each of these on the machine where it runs and prints one line per check,
`ok`, `FAIL` or `n/a`. A refusal from the sandbox reaches the line as the first 160 characters of
its own text, so it can be pasted back. It only reads: `python3 --version`, `gh --version`,
`gh api rate_limit`, `git remote`, the two fleet files, `memory_stats` on the Cortex server.

Two limits of the check are stated in its output. A model alias is only proven by a paid
completion, which the check does not make, so it prints `n/a` for the models. The options of
`cortex-guard` and `harness-fleet` are not readable from another mod (they publish none in their
state, and the engine did not list their rows in the run below); the check then says so, and
checks the hygiene script at its default location.

Measured, on one Mac (Claude Code 2.1.293, no company sandbox): with a pristine `settings.json`
holding `{}` and an isolated `CLAUDE_CONFIG_DIR`, loading all six by `CLAUDE_CODE_PLUGIN_DIRS` lists
all six as `loaded` and leaves `settings.json` at `{}`; `cortex-cockpit` or `zetetic-autopilot`
loaded alone is `disabled` with the dependency error above; `/cortex check` run headless
(`claude -p "/cortex check"`) answers one line per check, and reports `harness-fleet` and
`cortex-wiki` as not loaded when only the other four are.

Not measured: the managed-settings lock itself (it could not be reproduced), whether a company
policy accepts `--plugin-dir`, any refusal of a real sandbox (blocked network, denied `exec`,
unreadable `~/.claude`), the Cortex server answering through `/cortex check` (the headless run had
no MCP server connected, and the check printed the engine's refusal for it), the model aliases, and
whether `/config` lists the options of directory-loaded mods in an interactive session.
