# zetetic-insights: the outcome model

What the insights mod counts as "the work went well", where each signal is read, and what it cannot
see. One definition per measured quantity; the code that implements each is named.

## 1. Sources

| Signal | Read at | From | File |
|---|---|---|---|
| Outcome events (below) | `tool.call` of a Bash call, main or agent | the command text (primary), the Bash result's `gitOperation` (corroborates, gives sha and PR number), the result's error line | `hooks/events.ts` |
| Test exit status | same | `isError` and the first line `Exit code N` of the result text (the typed Bash result carries no exit code) | `exitOk` |
| Live friction | `tool.call` of any tool | a refusal (`deny`), or an errored call matched by the closed rules of `friction.ts` `toolErrorKind`; a Bash command's own non-zero exit is none | `liveFrictionOf` |
| Session origin | `session.start` | `isInteractive`, `cwd` under the OS temp dir (`/tmp`, `/private/tmp`, `/var/folders`, `TMPDIR`, `TEMP`, `TMP`) | `hooks/probes.ts` |
| Facets | session start | `~/.claude/usage-data/facets/<sid>.json` (written by `/insights`), when present | `learn.ts` `outcomeOf` |
| Transcript frictions | after a session ends | `transcript:<sid>`, kept as an extra source | `friction.ts` |

Events ride in the turn record (`TurnRecord.events`, `frictions`), so the store cap of 3 MiB for the
ledger (`LEDGER_BYTES`, serialized-size trim) covers them with no new key.

## 2. Events (the closed list)

`commit` (sha, amended or not) · `revert` (sha or HEAD) · `reset` (`HEAD~n`/`HEAD^` reaches back n) ·
`test` (runner label, `ok` true / false / null) · `push` · `pr-create` · `pr-merge` · `pr-close` ·
`verdict` (a `gh pr comment` whose body opens `ZETETIC-REVIEW: APPROVE|REQUEST-CHANGES`, the head sha
on the next line; a body in `--body-file` is read, an unreadable one is `unknown`).

Attribution: the engine's `agentId` on the `tool.call` event. Absent means the main thread. A review
verdict or a merge is usually the main thread's; it is joined to the delegation by PR number, or by
the head sha the verdict cites matching a commit of the delegation.

What is not seen, by construction:

- A runner outside the list (`TESTS` in `events.ts`).
- The exit status of a runner whose output is piped (`| tail`) without `pipefail`: `ok: null`, not counted.
- Which segment of a failed `&&` chain failed: a failed call claims no commit, push or merge unless
  `gitOperation` confirms it.
- What a `git reset` with a target other than `HEAD~n` / `HEAD^` discarded. `HEAD~n` marks the n
  latest live commits `possiblyDiscarded`: reported, never counted as reverted.
- A PR number is joined within one session. A merge in another session is not joined.
- Hook timeouts: the engine raises no event for a hook that overran; they cannot be counted. A hook's
  refusal of a tool call is seen (it is a `deny`).

## 3. Judgement of a delegation (`hooks/outcome.ts` `judge(events, agentId)`)

Evaluated at read time over the whole session, in this order; the first that holds decides.

1. A commit of the delegation was reverted (`git revert <sha>`; `HEAD` resolves to the latest commit before it): **not achieved** (`reverted`).
2. A PR of the delegation is merged, its last verdict is APPROVE, no commit of the delegation is newer than that verdict, and the cited head matches a live commit of the delegation: **achieved** (`merged-approved`).
3. Merged with an APPROVE that is stale (a newer commit, or another head): **unclear** (`approve-stale`).
4. A PR of the delegation was closed unmerged: **not achieved** (`closed`).
5. The last verdict on an unmerged PR is REQUEST-CHANGES: **not achieved** (`changes-requested`).
6. The final run of a test label failed and the delegation committed: **not achieved** (`tests-red`).
7. Otherwise **unclear** (`no-signal`).

A PR belongs to the delegation if it created it, or a verdict on it cites the delegation's commit.
`rounds` counts REQUEST-CHANGES verdicts on those PRs whatever the final state: a delegation that
needed two rounds and then merged is achieved with `rounds: 2`.

## 4. Judgement of a session

The same rules over all actors, plus one: **achieved** (`verified`) when the session has a live
commit, a passing run of some test label after the last commit, and no label whose final run failed.
The session's outcome is the events' judgement when it is not `unclear`, else the facet's. When both
speak and differ, the events stand and `outcomeSources.disagree` counts it.

## 5. Probe sessions (`hooks/probes.ts`)

Counted in `InsightsState.probes` (by reason), excluded from learning, the brief and the chart rows
that fill slots; the chart's `SessionModels` rows carry `probe` and `probeReason`.

- `temp-cwd`: the cwd is under an OS temp dir (stamped on every record, or read from the transcript
  path's project folder for records written before the stamp), whatever the length.
- `non-interactive-1-step`: a `-p` run or the SDK with at most one main step.
- `one-step-unknown`: the origin was never recorded (older records), one main step, no agent. Steps,
  not turns: a one-turn session of three steps is work.
