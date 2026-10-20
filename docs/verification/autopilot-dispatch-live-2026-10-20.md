# Live dispatch probe, zetetic-autopilot 0.11.0

Run 2026-10-20 with Claude Code 2.1.304, from an empty registered temp directory: `claude -p --model sonnet --permission-mode bypassPermissions --output-format json --plugin-dir mods/zetetic-autopilot --settings '{"enabledPlugins":{"zetetic-autopilot@claude-mods":false},"pluginConfigs":{"zetetic-autopilot":{"options":{"policy_mode":"enforce","quota_pressure_percent":80,"max_parallel_agents":5}}}}' "<prompt>"` (the installed 0.10.0 disabled, this branch's copy loaded by directory). Session 38452c99-d090-436a-9916-594c93c2e9b1.

The main model was told to make six general-purpose Agent calls without model or effort, one prompt per class. Prompt:

```
You are running a dispatch probe. Make exactly six Agent tool calls, one after the other (wait for each to finish before the next). For every call use subagent_type "general-purpose", the description given, and the prompt given, copied verbatim. Do not pass the model parameter and do not pass the effort parameter. Do not do any of the tasks yourself. After the sixth call, print the word done.

Call 1, description "probe routine", prompt:
List the names of the files in the current working directory and report them as a bullet list. Nothing else.

Call 2, description "probe planned", prompt:
Implement exactly this written plan, nothing more: step 1, create a file named plan.txt in the current working directory; step 2, write the single line done into it; step 3, reply with the word ok.

Call 3, description "probe bugfix", prompt:
Fix this bug. The function `def add(a, b): return a - b` must return the sum of a and b, and the cause is the minus sign. Reply with the corrected line only.

Call 4, description "probe analysis", prompt:
Design the module boundary for a small caching layer that sits between an HTTP handler and a SQL database in a multi-file service: name the interfaces, which side owns invalidation, and why, in at most ten lines. Do not write code.

Call 5, description "probe critical", prompt:
Determine whether this code can lose increments under concurrency and prove your answer: two threads each run `for i in range(1000): count = count + 1` on a shared integer with no lock, in CPython with the GIL. A wrong answer here corrupts a billing counter. Answer in at most six lines.

Call 6, description "probe review", prompt:
Review this existing diff of a pull request and report every defect you find, in at most four lines:
-    return a + b
+    return a - b
(in the function add(a, b), whose docstring says it returns the sum).
```

The six Agent calls as the main transcript holds them (description, type, model key present, effort key present):

```
probe routine general-purpose False False
probe planned general-purpose False False
probe bugfix general-purpose False False
probe analysis general-purpose False False
probe critical general-purpose False False
probe review general-purpose False False
```

Per subagent: every `api-request` record of its transcript (`params.model`, `params.output_config.effort`) and the autopilot's spawn record (inline store, key `spawns:…:38452c99-…`):

```
session 38452c99-d090-436a-9916-594c93c2e9b1 main transcript ['/Users/cdeust/.claude/projects/-private-tmp-claude-501--Users-cdeust-Developments-anthropic-partnership-Cortex-c8d24530-e1c4-4d87-af2b-ecb384cb2fe1-scratchpad-disk-hygiene-z9wvz3z-/38452c99-d090-436a-9916-594c93c2e9b1.jsonl']
{"agent": "a0ead8142d59a2946", "description": "probe routine", "requests": [["claude-sonnet-5-5", "low"], ["claude-sonnet-5-5", "low"]], "record": {"reason": "table", "decided": "sonnet", "ran": "claude-sonnet-5-5", "applied": true, "cls": "routine", "review": false, "effort": "low", "effortReason": "table", "effortApplied": true}}
{"agent": "a4632d29ef6f7067d", "description": "probe bugfix", "requests": [["claude-sonnet-5-5", "medium"]], "record": {"reason": "table", "decided": "sonnet", "ran": "claude-sonnet-5-5", "applied": true, "cls": "bugfix", "review": false, "effort": "medium", "effortReason": "table", "effortApplied": true}}
{"agent": "aa382a1e4730120d5", "description": "probe planned", "requests": [["claude-sonnet-5-5", "low"], ["claude-sonnet-5-5", "low"]], "record": {"reason": "table", "decided": "sonnet", "ran": "claude-sonnet-5-5", "applied": true, "cls": "planned", "review": false, "effort": "low", "effortReason": "table", "effortApplied": true}}
{"agent": "ab208124a7798594e", "description": "probe critical", "requests": [["claude-opus-5-5", "high"], ["claude-opus-5-5", "high"], ["claude-opus-5-5", "high"]], "record": {"reason": "table", "decided": "opus", "ran": "claude-opus-5-5", "applied": true, "cls": "critical", "review": false, "effort": "high", "effortReason": "table", "effortApplied": true}}
{"agent": "ae8db2c9bf76cc41c", "description": "probe analysis", "requests": [["claude-opus-5-5", "medium"]], "record": {"reason": "table", "decided": "opus", "ran": "claude-opus-5-5", "applied": true, "cls": "analysis", "review": false, "effort": "medium", "effortReason": "table", "effortApplied": true}}
{"agent": "aeea3c4b596cd0dd4", "description": "probe review", "requests": [["claude-sonnet-5-5", "medium"]], "record": {"reason": "table", "decided": "sonnet", "ran": "claude-sonnet-5-5", "applied": true, "cls": "routine", "review": true, "effort": "medium", "effortReason": "table", "effortApplied": true}}
```

Result: 6 of 6 spawns decided by the table (`reason: table`), 6 of 6 classes as the prompts were written (the review one graded `routine` review, rung sonnet/medium), 10 of 10 API requests at the decided model and effort.
