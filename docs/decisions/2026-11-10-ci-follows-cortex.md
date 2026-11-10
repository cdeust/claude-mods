# The CI follows Cortex: the Claude verdict decides the merge

Date: 2026-11-10. Owner direction, 2026-11-09: Cortex's CI is the source of truth, the
other repositories follow it, and each one gets the Claude reviews Cortex has.

## Change

- `claude-review.yml` and `scripts/ci_review_budget.py` are Cortex's: at most three
  automatic reviews per pull request, each ending with `Verdict: approve` or
  `Verdict: block` (Cortex ADR-1119).
- The `resolve` job of `pipeline-post-merge.yml` is Cortex's, with `close-issues`: it
  merges a head whose Pipeline succeeded and whose latest verdict, bound to a review run
  of that head, approves (ADR-1121). `pipeline-after-merge.yml` listens to `Pipeline`
  and `PR Review`, so whichever ends last wakes the resolver (ADR-1127).
- The `review` job of `pipeline.yml`, `Codex.yml`, the `scripts/ci_codex_*.py` modules
  and their tests are removed (ADR-1120: the reviewer is `claude-review.yml`).
- Six test files of Cortex's resolver and budget run in `unit`; PyYAML 6.0.3 joins the
  hash-locked `requirements-ci-coverage.lock` for the one test that parses the workflow.

## Reason

The merge did not depend on the Claude review, which had no verdict line and no cap.

## Result

The exact `unit` test command in a fresh hash-locked environment: 66 tests pass;
`scripts/` line coverage 92 % (61 statements, 5 missed), floor 90 %. Hosted behaviour is
proven by the first pull request after this one merges: the resolver that handles this
pull request is the one on `main`.
