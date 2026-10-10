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
- `npm run test:codex`: 18 tests pass: five public command subprocess tests and thirteen native-envelope hook subprocess tests. Initial command tests failed 5/5 before the CLI existed; initial runtime tests failed 3/3 before the hook existed.
- Actual `codex plugin marketplace add <repository>` and `codex plugin add claude-mods@claude-mods-codex --json` succeeded, in both an isolated CODEX_HOME and the normal configuration. Installed version: 0.1.0.
- Native `/hooks` displayed four new hooks, attributed to `claude-mods@claude-mods-codex`, with the installed `runtime/hook.mjs` command. No hand-written trust hash.
- Real wiki rendering through existing pandoc/xelatex exited 0 and produced a PDF from a wiki Markdown/TikZ source in a registered disposable test directory. No auto-open.
- Real fleet read returned GitHub PR/issue observations for cdeust/claude-mods. The pre-existing `session-optimizer-marketplace` manifest error stayed visible as a failed plugin catalog reading; it was not converted to an empty catalog or repaired by this change.

## Native activation

The owner explicitly authorized trust of the four hooks on 2026-10-10. Each hook was inspected and trusted individually through native `/hooks`; no trust hash was edited.

Fresh Codex session `01a125d8-9e62-7bb1-a4ee-fac7b0df1f13` recorded SessionStart, UserPromptSubmit, PreToolUse and PostToolUse through installed version 0.1.0. A real `pwd` completed. A native `apply_patch` attempt to create `wiki/specs/codex-native-guard-probe.md` was denied by the wiki guard, and the file remained absent.

The native worktree probe exposed a contract mismatch: shell `tool_response` is text, without a structured exit status. The installed client source confirms this representation in [Codex rust-v0.162.1 hooks tests](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/tests/suite/hooks.rs#L5453-L5461). Version 0.1.1 replaces status inspection with a paired native-call intent and real Git ownership verification. Regression tests exercise actual Git creation with textual output, failed creation with spoofed output, existing paths, unpaired results and competing calls.

Final installed 0.1.1 worktree verification is recorded separately in the project evidence after publication and installation.

Model routing remains advisory. Persistent cockpit UI, quota/usage telemetry and arbitrary result rewriting are unsupported by this adapter.

## Review corrections in 0.1.2

Two review reproductions are now regression cases. Native Bash envelopes omit execution workdir, so worktree additions require explicit absolute git -C instead of relying on the session directory. The shell lexer distinguishes operator tokens from quoted words and heredoc bodies before resolving file operands. Long script strings no longer reach lstat as filenames. Actual redirects and supported write commands remain guarded, including literal shell control/group prefixes and command/env wrappers.

The runtime suite initially had10 passing and3 failing cases for these additions. All13 runtime cases now pass. Shared generated-source checks pass, and the original Claude mod sources/manifests remain unchanged. The lexer follows the installed bash(1) token recognition and here-document rules; it does not evaluate shell expansions. Unsupported dynamic guarded operands are refused.
