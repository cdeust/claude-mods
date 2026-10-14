# Autopilot routing reads agent definitions (2026-10-14)

Probe: a mod logging `agent.spawn` (call model, parent, resolved model) and `turn.step`
(agent id, index, model, effort), run headless with `claude -p ... --plugin-dir`.

## What the engine does without the autopilot

| Type | Call `model` | Parent | Resolved | Step effort |
|---|---|---|---|---|
| zetetic-team-subagents:security-auditor (defined opus/high) | none | sonnet 5.5 | opus 5.5 | high |
| zetetic-team-subagents:memory-writer (defined haiku/low) | none | sonnet 5.5 | haiku 5.5 | low, low |
| Explore, Plan, general-purpose | none | opus 5.5 | opus 5.5 (inherit) | medium |

`agent.spawn` never carries the definition's model: the hook sees `model` undefined.

## Before (main 994c88b) and after (this branch), parent fable 5.1

| Agent | main | branch |
|---|---|---|
| advisor (defined fable/high) | resolved **opus 5.5** | resolved fable 5.1, effort high at steps 0 and 1 |
| memory-writer (defined haiku/low) | haiku under no pressure; **sonnet** under pressure (pure test) | haiku 5.5, effort low |

Subagent effort after step 0 (`effortFor` index > 0 clamp to medium on main) is covered by
`route.hook.test.ts` ("a subagent's tool loop keeps its definition's high effort"); the probe
cannot tell whether its own `turn.step` hook sits above or below the autopilot's.

Gates: `claude plugin validate .` passed, `claude plugin test` 44 pass, `tsc -p . --noEmit`
clean, `scripts/check-shared.sh` identical.
