# claude-mods

Claude Code mods and a separate [Codex adapter](codex/README.md) for the ai-architect.tools harness.
The Claude mods keep one concern per mod, state shared through
`dependencies`:

| Mod | Owns | Depends on |
|---|---|---|
| `cortex-guard` | `refusals`: wiki pages only through `wiki_write`, worktrees inside `<repo>/.claude/worktrees/` | nothing |
| `cortex-wiki` | `/wiki <wiki/**.md>` to PDF | nothing |
| `zetetic-genius` | `state`: the request grade (task class → effort), the genius patterns and skills it matches | nothing |
| `zetetic-autopilot` | `context`, `policy`, `phases`: effort ladder, model routing (a subagent's call, then its own definition, then its prompt's DESIGN block, never lowered by pressure), the dispatch table (`hooks/dispatch-table.ts`): an inheriting subagent nobody designed runs at the model and effort of its task's class, graded by one classifier completion (`cls`/`review` on each spawn record the table decided, absent before 0.11.0), an inheriting subagent's effort from the turn's grade when its call names a model but no effort (`effort` on each spawn record, absent before 0.10.0), the quota's cap on the main loop's parallel subagents, offloaded tool results; the phase each loop is in, on each run the steps a stuck escalation raised (`escalated`, absent before 0.8.0), and the advisor calls | `zetetic-genius` |
| `zetetic-insights` | `insights`: the turn ledger across sessions ($.store), joined with `/insights` session outcomes and `.zetetic/goals`; per-phase effort proposals, `/calibrate apply\|reset`, the calibration file the autopilot reads | `zetetic-autopilot`, `zetetic-genius` |
| `mission-control` | `renderer`; the `/mission` pane: the turn's lanes by phase (bar height = effort, advisor calls, failed calls), effort per phase, learning curves per phase. Pixels in kitty or Ghostty outside tmux, coloured cells elsewhere | `zetetic-autopilot`, `zetetic-insights` |
| `harness-fleet` | `fleet`: the owner's plugins, installed vs offered version, open PRs with CI, open issues (a defect is taken and fixed, a feature request goes to the owner); `/fleet`. Reads only (`gh pr list`, `gh issue list`, `git remote`): every outward action is a button the owner presses, which puts a prompt in front of the model | guard, genius, autopilot |
| `superpowers` | third-party skills library (obra/superpowers, MIT), pinned to v7.0.0 `bb92a77`: listed here so it installs with the mods; which skills we keep is decided after measurement | nothing |

## Audience

Each output of a mod has one reader, and the engine fixes the reader by the API the output goes through
(there is no per-call option): `$.ui.toast`, `$.ui.log`, `$.ui.status`, panes and rows are the user's, and
the model never sees them; a `tool.call` result's `context`, a `prompt.submit` `context` and `prompt.compose`
sections are Claude's, and the user never sees them; a `deny` is the model's tool error (the transcript
draws it too). A text is written for its reader, and one string is never sent to both. The mods that send
to both say which text is whose:

- `zetetic-autopilot`: the user reads a toast when main implements (what main ran) and when a subagent
  spawn is refused (which spawn, how many run, the cap and the window: no instruction); Claude reads, in the
  context of main's first implementing tool result of a turn, the rule to delegate to a subagent, and, as
  the Agent tool's error, the cap refusal with the way out (wait for a running agent to finish, spawn again).
- `cortex-guard`: the user reads a toast for each refusal, for a worktree that was not registered, and for a
  guard that failed; Claude reads the refusal's rule and fix as the tool's error (the same error when the
  guard itself failed), and, in the context of the result of its `git worktree add`, that the worktree was not
  registered and its cleanup is not covered.
- `harness-fleet`: the user reads the `/fleet` pane and its toasts; Claude reads only what a button the user
  presses puts in front of it (review, take an issue, draft an issue), as "The harness-fleet plugin sent a
  message: ..." in the plugin's own voice: the owner is "the owner" in it, never "me" or "I".

## Developing

Each mod is validated, tested and type-checked on its own:

```sh
cd mods/<mod> && claude plugin validate . && claude plugin test && npx -y -p typescript tsc -p . --noEmit
```

`tsc` needs the engine to have loaded the mod once (it lays `.claude-plugin/types/`); keep `--noEmit`, since a plain `tsc -p .` writes `.js`
files beside the sources. For hot
reload in a session, link the mod into that session's `~/.claude/dev-mods/<session>/` folder;
the engine watches the folder a link names.

A mod cannot import a file from another mod (the engine refuses it: "outside the plugin's folder"),
so the few small pure files several mods need are copied into each of them: `hooks/paths.ts`
(where `~/` lands: HOME, else USERPROFILE, `CLAUDE_CONFIG_DIR` for `~/.claude`) in five mods, and
`hooks/design.ts` (the one parser of a prompt's DESIGN block) in `zetetic-insights` and `zetetic-autopilot`,
each with its test. After editing one, copy it over the others; this fails when a copy differs:

```sh
sh scripts/check-shared.sh
```

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
  --plugin-dir $MODS/zetetic-insights \
  --plugin-dir $MODS/mission-control \
  --plugin-dir $MODS/harness-fleet

# or one variable, colon separated
CLAUDE_CODE_PLUGIN_DIRS=$MODS/cortex-guard:$MODS/cortex-wiki:$MODS/zetetic-genius:$MODS/zetetic-autopilot:$MODS/zetetic-insights:$MODS/mission-control:$MODS/harness-fleet claude

# an alias in the shell profile: it sets MODS itself, because the alias body is single-quoted and
# is expanded each time it runs, not when the profile is read
alias claude-mods='MODS=/path/to/claude-mods/mods; CLAUDE_CODE_PLUGIN_DIRS=$MODS/cortex-guard:$MODS/cortex-wiki:$MODS/zetetic-genius:$MODS/zetetic-autopilot:$MODS/zetetic-insights:$MODS/mission-control:$MODS/harness-fleet claude'
```

Which form to prefer: an interactive session may ask for a login when `CLAUDE_CONFIG_DIR` points at
an empty directory (seen once in an isolated directory, where headless `claude -p` did not ask).
On the machine's own configuration directory, which is already logged in, that does not apply;
use the repeated `--plugin-dir` or the alias there, and keep an isolated `CLAUDE_CONFIG_DIR`
for tests only.

`claude plugin list` shows them under "Session-only plugins" with `Status: loaded`.

What then must hold:

- The `dependencies` of a mod are resolved among the mods loaded in the same command, so load a
  mod together with what it names: `zetetic-autopilot` needs `zetetic-genius`;
  `harness-fleet` needs `cortex-guard`, `zetetic-autopilot` and `zetetic-genius`. A mod whose dependency is absent is listed `disabled`, with the error
  `Dependency "<name>" is not installed`.
- Options cannot be set (they live in `settings.json` under `pluginConfigs`), so every default in a
  `plugin.json` has to be right on any machine:

| Mod | Option | Default | Notes |
|---|---|---|---|
| `cortex-guard` | `hygiene_script` | `~/Developments/disk-hygiene/disk_hygiene.py` | `~/` is the home of the user running the session, read at runtime. When the file is not there, one toast per session says `hygiene script not found at <path>; worktrees are not registered`; an empty value disables the registration without a toast. A `python3` that fails to start gets one toast naming the cause, and no further worktree is registered for the session (no retry) |
| `zetetic-genius` | `mode`, `classifier_model` | `observe`, `haiku` | the grade is one low-effort completion on the `haiku` alias |
| `zetetic-autopilot` | `policy_mode`, `quota_pressure_percent`, `max_parallel_agents`, `offload_threshold_chars`, `offload_preview_chars` | `enforce`, `80`, `5`, `30000`, `2000` | the cap counts and refuses only the main loop's own spawns (a fork of main included): a subagent's nested spawn, a workflow script's `agent()` and a teammate are neither refused nor counted. A result past the threshold is written whole to a file in the session's tool-results directory (the engine's `cleanupPeriodDays` sweeps it, 30 days by default; the mod deletes nothing); the model reads the preview, the path and the size |
| `mission-control` | `renderer` | `auto` | `auto` draws pixels in kitty or Ghostty outside tmux (TMUX, TERM, TERM_PROGRAM, KITTY_WINDOW_ID), cells elsewhere; `cells` or `pixels` forces one |
| `harness-fleet` | `github_owner`, `refresh_on_start` | `cdeust`, `true` | reads `gh pr list`, `gh issue list` and `git remote` |

- The machine must let the mods do what they ask: `python3` (guard), `gh` and a route to
  `api.github.com` (fleet), the files under `~/.claude/plugins/` (fleet), `pandoc` and `xelatex`
  (wiki), and the model aliases (genius, autopilot).

Measured, on one Mac (Claude Code 2.1.293, no company sandbox): with a pristine `settings.json`
holding `{}` and an isolated `CLAUDE_CONFIG_DIR`, loading the mods by `CLAUDE_CODE_PLUGIN_DIRS` lists
them as `loaded` and leaves `settings.json` at `{}`; `zetetic-autopilot` loaded alone is
`disabled` with the dependency error above.

Not measured: the managed-settings lock itself (it could not be reproduced), whether a company
policy accepts `--plugin-dir`, any refusal of a real sandbox (blocked network, denied `exec`,
unreadable `~/.claude`), the model aliases, and
whether `/config` lists the options of directory-loaded mods in an interactive session.
