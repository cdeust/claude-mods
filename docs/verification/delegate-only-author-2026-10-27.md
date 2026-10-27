# delegate-only: author verification, 2026-10-27

Branch `feat/delegate-only` from `origin/main` 66c78ac. Claude Code 2.1.311 (`claude --version`). The mod
`mods/delegate/` is the only directory under `mods/`. Nothing was ported from `zetetic-autopilot` (owner: it never
worked). Outputs below are copied from the runs, not paraphrased; a line says "not run" where it was not.

## Pillar 1: research

Checked against:

- https://code.claude.com/docs/fr/plugins/mods/overview, fetched 2026-10-27 (HTTP 200, 535298 bytes). Facts used:
  a mod is a module exporting `register(on, options)`; `on('tool.call', async ($, e, next) => ...)` runs before
  each tool use and `return next(e)` lets it run; `userConfig` declares the options; a mod cannot reshape the
  permission prompt, so passing a call through (`next(e)`) grants nothing the native permission rules refuse.
- The plugin-authoring reference and types (`/private/tmp/claude-501/bundled-skills/2.1.311/b0908b11bb71dc7d47fb4fc9f9f5f395/plugin-authoring/reference.md`,
  and the types the engine laid for this mod, `claude-code/index.d.ts`): `TurnStepInput` carries `model`, `effort`
  (`'low'|'medium'|'high'|'xhigh'|'max'|number`, optional), `agentId` (a subagent's id; absent on main), "a hook
  rewrites `model` or `effort` going down": this mod rewrites no step, so what its `turn.step` hook reads is what the
  engine applied. A guard is written with `.catch` (fail-open here, as before); a state value that must
  survive a reload goes in `$.state` with a `shape` tag (`rows-1` to `rows-2`).
- Two engine facts found by running, not in the docs I read: the engine refuses a second `tool.call` hook without a
  matcher ("registered twice without a matcher", every test failed to load), and a `tool.call` hook filtered with
  `{ tool: 'Agent' }` raises TS2589 ("Type instantiation is excessively deep") with typescript 5.6.3. This also
  held for the hook as it was before my changes (`tsc` of the finished mod in `~/.claude/dev-mods/` gave the same
  error at the same hook). Fix: one `tool.call` hook; the Agent call is told apart in its body.
- Not checked: the Stop reflection hook itself (it lives outside this repository); the two calls it needs are as the
  owner stated them.

Experiment log (one change at a time, failures kept):

1. Copied the finished mod (16 tests in 4 files; that unmodified copy was not run).
2. Added guard exception + `turn.step` record + tests: 23 pass, 1 fail (`$.ui.toasts is not a function`: wrong test API;
   a toast is captured with `on('ui.toast', ...)`). Fixed the test.
3. `tsc` on the copy: TS2589 at the Agent hook (also in the original). Tried (a) building the argument by mutation,
   (b) passing a plain object to `route`: no effect. Bisected in a scratch copy: even `return next(e)` as body fails
   when the hook is filtered; unfiltered with `if (e.tool !== 'Agent')` compiles.
4. Applied (3): 12 tests failed to load (second unmatched `tool.call`). Merged into one hook: 24 pass, tsc exit 0.
5a. The repository's staged-content gate (`staged_checks.py`, coding-standards size limit) refused the commit:
   `FUNCTION_TOO_LONG` on `register` (about 150 lines). Split it; the engine's load-time scan then refused, one at a time,
   a hook that is not a function literal or the name of one (a factory call), `$` passed into a rest parameter, and
   `update`/`read` on an atom defined in another file ("a reference ... written there or in a const of this file");
   a `Hook<'ui.render'>` const does not accept the `{ component, requestId }` matcher form (tsc), and a helper typed
   `Parameters<Hook<'tool.call'>>` made `tsc` report TS2589 at an unrelated test line. Final shape: the atoms and the
   state-touching hooks are named consts in `register.tsx`, the pane is a literal, pure parts are in `guard.ts`,
   `route.ts` and `steps.ts`. The gate then reported 0 errors, 0 warnings.
6. Mutation check of the new tests: removed the metacharacter check and the `..` check from `guard.ts` (not the tests): 3 tests fail
   (21 pass, 3 fail); restored: 24 pass.

## Pillar 2: SSDLC

Exact regex of the Bash exception (`mods/delegate/hooks/guard.ts`, `LIFT_COMMAND`), tested on the whole command:

```
^python3 \S+/reflection_ledger\.py --cwd \S+ lift [a-f0-9]+ --memory-id [0-9]+$
```

Applied only if the command also contains none of `; & | ` $ ( ) < > \r \n` (the owner's list) and, added by me as
stricter than asked, none of `' " \ { } * ? [ ] ! # ~` (quotes, backslash, brace and glob expansion, history,
comment, tilde: `\S+` alone lets `{a,--flag}` expand into extra arguments). The Read exception: absolute path, no
`..` segment, no NUL, `/.claude/projects/` then `/subagents/` after it, ends `.jsonl`.

Threat note (STRIDE, the exception only):

- Information disclosure (Read): the main loop can read any `*.jsonl` under a `.../.claude/projects/.../subagents/`
  path, that is subagent transcripts, which may hold file contents and tool results the subagents saw. It cannot read
  anything else through the exception. Residual: the match is on the path string; a symbolic link named like a
  transcript is followed by the OS, and `/tmp/x/.claude/projects/y/subagents/z.jsonl` also matches (the owner's
  rule is "under /.claude/projects/", not "under the home directory").
- Tampering / elevation (Bash): the main loop can run one program, `python3`, on a script whose path it chooses,
  ending in `/reflection_ledger.py`, with `--cwd` any word and a lift of a hex id and a numeric memory id. It cannot
  chain, redirect, substitute or expand. Residual: the script path is free, so a file named `reflection_ledger.py`
  that the main loop (or a subagent) wrote earlier would run; the main loop itself cannot write one (Write and Edit
  stay refused). The ledger script's own behaviour is outside this change.
- Denial of service / repudiation: refused calls are not counted as refusals and the exception leaves no row on the
  pane (a call the guard lets through is not recorded, as for orchestration tools).
- Spoofing: an `agentId` marks a subagent and is set by the engine, not by the call (unchanged).

Tests that bound it (`claude plugin test mods/delegate`, full output below): `guard.test.ts` refuses a chained
command (`;`, `&&`, `|`, `&`, newline, CR, `$(...)`, backticks, redirects, a leading `echo x;`, a subshell), a
variable, quotes, braces, a glob, an uppercase or non-hex id, a non-numeric memory id, another verb than `lift`,
`python3 -c`, another script name, leading and trailing blanks; refuses a Read of the main transcript (not under
`subagents/`), of `.json`, of an unrelated file, a relative path, `~/`, a path with `..` segments, a NUL.
`register.test.ts` runs the real hook in `block` (refusal text matches `delegate`) and `warn` (no toast and no count
for the two calls, one toast for a chained command).

Pinned tooling: `npm install -g @anthropic-ai/claude-code@2.1.306` (as in the pipeline's `ci.json`, existing pin);
`typescript@5.6.3` through `npx -y -p`; node and npm as installed on the author's machine (not pinned: no
`package.json` remains). Dependencies of the mod: none (it imports `claude-code` only). The mod ships no SBOM: no
third-party package is bundled. SAST/DAST beyond the engine's `validate` and the tests: not run (no scanner is configured
in this repository).

## Pillar 3: operations

- Turn the mod off: set `main_mode` to `off` (`settings.json` under `pluginConfigs`, or `/config`). Then the main
  loop is not guarded, no delegation text is added to the system prompt, and the mod only routes `Agent` calls.
  `warn` keeps the toasts. `/plugin uninstall delegate` removes it. A hook of the mod that fails lets the call go on
  as if the mod were absent (`.catch(($, e, next) => next(e))` on `tool.call` and `agent.spawn`; the `turn.step`
  recorder swallows its own failure in a `try`).
- Rows already stored under `rows-1` are read as empty after the update (shape tag `rows-2`); nothing else is migrated.
- Rollback: revert the commit; the removed mods are in git history (tags `<mod>/v<version>` remain on the remote).
- The pipeline (`ci.json`) now validates and tests `mods/delegate`; see "What I could not verify".

## Commands and outputs

### `claude plugin validate mods/delegate`

Exit status 0. Last lines (full output has the manifest, hooks and directory checks):

```
  ❯ hooks/hooks.json names a hooks module (a code file listed under `modules`). The plugin directory has rules of its own for such code, and these checks apply none of them, so passing here does not mean the directory accepts the plugin. The developer portal's own validation applies those rules.

These plugin directory checks do not change the result below. To fail on problems the directory refuses a submission for, run this command with --profile directory.

The directory also runs a safety scan and a policy review that this command does not.

✔ Validation passed
```

The same output reports, as directory checks that do not change the result: `LICENSE_MISSING` (no LICENSE in the
mod or at the repository root; the repository has none, so none was invented) and `ICON_MISSING`. Hooks line of the
report: `./register.tsx hooks: session.start, command.run{command=delegate}, prompt.compose, tool.call, agent.spawn, turn.step, turn.complete, ui.render{component=Pane, requestId=delegate}`;
`gating hook with .catch: tool.call`, `gating hook with .catch: agent.spawn`.

### `claude plugin test mods/delegate`

Exit status 0.

```
hooks/guard.test.ts:
(pass) orchestration tools stay, work tools go [1.39ms]
(pass) the memory servers stay [0.24ms]
(pass) the extra list matches a name or a prefix [0.40ms]
(pass) the transcript of a subagent may be read, nothing else [0.39ms]
(pass) only the ledger lift may be run, as one plain command [0.98ms]
(pass) a reflection call is a Read of a transcript or a lift, by tool [0.22ms]

hooks/pane.test.tsx:
(pass) the pane shows a routed delegation, on every surface [45.92ms]
(pass) the pane shows asked and ran for model and effort, and ? until a step is seen [28.61ms]
(pass) a step that comes before the spawn answers is kept for the row [21.44ms]
(pass) a step goes down to the engine as it came, with or without an effort [19.92ms]
(pass) an empty pane says so [18.68ms]

hooks/register.test.ts:
(pass) the main loop is refused a work tool, a subagent is not [34.01ms]
(pass) warn mode lets the main loop through [16.67ms]
(pass) off mode touches nothing [15.69ms]
(pass) an Agent call without model or effort is routed, a named one is kept [19.53ms]
(pass) block: the main loop may read a subagent transcript and run one lift, no more [24.09ms]
(pass) warn: the two reflection calls pass without a toast or a count, any other work tool is counted [18.20ms]
(pass) the system prompt gains the delegation section [15.20ms]

hooks/route.test.ts:
(pass) explore, web and search work runs on haiku at low effort [1.78ms]
(pass) a very thorough exploration gets medium effort, still haiku [0.19ms]
(pass) implementation runs on sonnet, judgment on opus [0.26ms]
(pass) building outranks reading, judgment outranks building [0.16ms]
(pass) a fork and a custom type are left alone [0.13ms]
(pass) an unclassified task is sonnet at medium, not haiku [0.10ms]

 24 pass
 0 fail
Ran 24 tests across 4 files. [0.31s]
```

### `npx -y -p typescript@5.6.3 tsc -p . --noEmit` in `mods/delegate`

Exit status 0, no output. The engine did not lay `.claude-plugin/types/` in the worktree (neither `validate` nor
`test` writes it), so the types the engine had written for this mod in
`/Users/cdeust/.claude/dev-mods/a68ba02b-6fcb-427b-8766-d073b0efff29/delegate/.claude-plugin/types/` (Claude Code 2.1.311)
were copied into the git-ignored `mods/delegate/.claude-plugin/types/` for the run and removed afterwards. The bundled
`claude-code.d.ts` was not used.

## What I could not verify

- A live session: the `/delegate` pane with a real subagent, the `turn.step` record on a real engine, and the Stop
  reflection hook's real calls were not run; the tests drive the hooks through the engine's test kit.
- The pipeline: `ci.json` was rewritten but the GitHub pipeline was not run before the push. Its unit step requires a
  Cobertura `coverage.xml` at 90 % of lines (the old unit command produced it from the `codex/` tests, now removed);
  the new unit command produces none, so that step is expected to fail until the owner decides what measures coverage
  for `.ts` mods (no inventing of infrastructure here).
- `plugin.json` `license`: not set; `claude plugin validate --profile directory` was not run (it would report
  `LICENSE_MISSING`).
