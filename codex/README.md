# Codex adapter

This directory is a self-contained Codex plugin. The original six Claude mods and their marketplace are unchanged. Codex packages these concerns together so its hooks and skills share one plugin data directory.

## Install

Requires Node.js 24 or newer on PATH. No npm install, Python package or model provider is bundled.

```sh
codex plugin marketplace add cdeust/claude-mods
codex plugin add claude-mods@claude-mods-codex
```

For development, give `marketplace add` the absolute repository path instead. Start a fresh Codex session, open `/hooks`, inspect this plugin’s hooks and trust them using the native UI. Installation alone does not establish hook trust. Do not edit trust hashes by hand. Installing this adapter does not install or change the Claude mods.

## Available behavior

| Claude concern | Codex behavior |
|---|---|
| cortex-guard | PreToolUse refusals for protected wiki/ADR paths and unsafe worktree destinations; PostToolUse registration of successful worktree additions with disk-hygiene |
| cortex-wiki | `$wiki` renders a wiki Markdown file to a new PDF using existing pandoc/xelatex; it does not open it automatically |
| zetetic-genius | `$genius` exposes the existing task classifier prompt and explicitly supplied installed pattern/routing tables; the running agent applies the guidance |
| zetetic-autopilot | `$autopilot` reports the shared task-class → effort recommendation; advisory only |
| cortex-cockpit | `$cortex` reads this plugin’s session hook observations; no persistent terminal pane, quota estimate or token usage claim |
| harness-fleet | `$fleet [owner/repo ...]` reads Codex’s plugin catalog and the selected repositories’ PRs/issues; partial readings and errors stay explicit |

Skills contain a `scripts/run.mjs` entrypoint. They can also be invoked directly:

```sh
node /absolute/plugin/path/commands/mods.mjs autopilot analysis
node /absolute/plugin/path/commands/mods.mjs genius /path/to/genius/INDEX.md /path/to/skill-routing-table.md
node /absolute/plugin/path/commands/mods.mjs fleet cdeust/claude-mods
node /absolute/plugin/path/commands/mods.mjs wiki wiki/specs/example.md /tmp/example.pdf
```

The guard is a workflow guard, not a filesystem security boundary. Shell protection is best effort; arbitrary scripts, interpreter code and dynamic shell expressions are not a complete mediated filesystem. Native Codex permissions remain responsible for access control. Worktree commands whose destination cannot be established are refused. Shell commands do not gain approval merely by passing this plugin.

Automatic worktree registration currently requires a structured numeric host exit status; unknown result shapes produce a visible registration warning and require manual registration. Native acceptance remains pending as described below.

The hygiene script is the existing `~/Developments/disk-hygiene/disk_hygiene.py`; its failure must be surfaced rather than treating the worktree as registered. No tool installation is performed.

## State and limits

Hooks append minimal session observations to `PLUGIN_DATA/sessions/<sha256(session_id)>.jsonl`. They do not retain prompts, command bodies, tool results or the ambient environment. To read a report directly, supply the same PLUGIN_DATA and native session id to `cortex`. Missing or unreadable telemetry is an error, not an empty successful session.

This adapter does not rewrite subagent model/fork arguments, automatically classify every prompt with a paid model, change root model/effort at each internal step, or replace arbitrary tool results. These Claude engine behaviors have no equivalent used here. The Codex app-server documents per-turn model/effort overrides, but this plugin does not own the host or implement an app-server controller.

Hook and plugin contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [plugin packaging](https://developers.openai.com/plugins/build/plugins), [app-server](https://learn.chatgpt.com/docs/app-server). The shared effort taxonomy and guard rules retain their original source comments under `mods/`.

## Develop and verify

```sh
npm run build:codex
npm run check:codex
npm run test:codex
sh scripts/check-shared.sh
```

Use the build version pinned in `.nvmrc` (24.7.0). `codex/shared/*.mjs` is generated from an explicit list of existing pure TypeScript modules using Node’s [stripTypeScriptTypes](https://nodejs.org/api/module.html#modulestriptypescripttypescode-options). Commit those generated files so the installed plugin needs no build tool. The check compares generated output byte-for-byte. Claude’s own `claude plugin validate` and `claude plugin test` remain the compatibility gates; a passing Codex hook test is not Claude engine evidence. Native validation results live in [verification.md](verification.md).
