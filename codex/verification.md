# Verification: Codex adapter

Date: 2026-10-10. Baseline: origin/main `52ac900e0f5abd6bdf1a18d307d823f25b60c6ea`.
Hosts: Node.js 24.7.0, Codex CLI 0.162.1, Claude Code 2.1.296, macOS.

## Claude compatibility

All original `mods/**` sources and `.claude-plugin/**` manifests are unchanged.
Each mod passed `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`:

| Mod | Passing tests |
|---|---:|
| cortex-guard | 33 |
| cortex-wiki | 7 |
| zetetic-genius | 21 |
| zetetic-autopilot | 33 |
| cortex-cockpit | 81 |
| harness-fleet | 46 |
| Total | 221 |

`sh scripts/check-shared.sh`: every shared file is identical in all of its mods.
This is the Claude engine’s own test runner. No new paid Claude completion or interactive pane run was used as evidence.

## Codex package and local workflows

- `npm run check:codex`: generated modules match their TypeScript source exactly.
- `npm run test:codex`: 11 tests pass: five public command subprocess tests and six native-envelope hook subprocess tests. Initial command tests failed 5/5 before the CLI existed; initial runtime tests failed 3/3 before the hook existed.
- Actual `codex plugin marketplace add <repository>` and `codex plugin add claude-mods@claude-mods-codex --json` succeeded, in both an isolated CODEX_HOME and the normal configuration. Installed version: 0.1.0.
- Native `/hooks` displayed four new hooks, attributed to `claude-mods@claude-mods-codex`, with the installed `runtime/hook.mjs` command. No hand-written trust hash.
- Real wiki rendering through existing pandoc/xelatex exited 0 and produced a PDF from a wiki Markdown/TikZ source in a registered disposable test directory. No auto-open.
- Real fleet read returned GitHub PR/issue observations for cdeust/claude-mods. The pre-existing `session-optimizer-marketplace` manifest error stayed visible as a failed plugin catalog reading; it was not converted to an empty catalog or repaired by this change.

## Native activation pending

Automatic approval review rejected pressing `t` to trust the new PreToolUse hook, because trust persistently enables plugin code outside the sandbox and requires explicit user authorization. No further trust action was attempted. All four hooks remain untrusted pending approval. Therefore no native SessionStart/UserPromptSubmit/PreToolUse/PostToolUse receipt is claimed. Subprocess tests do not establish native acceptance.

Worktree auto-registration recognizes structured numeric exit status only. An unknown host result produces an explicit “registration not verified” message; it must be tested against an actual successful native worktree operation after activation. Model routing remains advisory. Persistent cockpit UI, quota/usage telemetry and arbitrary result rewriting are unsupported by this adapter.
