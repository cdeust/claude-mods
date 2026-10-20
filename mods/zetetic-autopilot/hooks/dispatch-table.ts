// The dispatch table: which model and effort a subagent runs at when nobody designed them, by the class of its task.
// Data only, every row with its source; dispatch.ts evaluates it. A plain literal in a .ts file because the engine
// loads only code-named files (`cannot import "./table.json" ... is not named like code and was not loaded`, the
// validator and the test kit alike, probed 2026-10-20), so a .json could only be read at run time and its shipped rows
// could never be under the mod's own tests. An edit here ships with a version bump, as any edit of the mod does.
// source: ~/.claude/fleet/research/mods-auto-dispatch-gap.md § 3.2 (the rows are the calibration file's, not new numbers)

import type { DispatchTable } from './dispatch'

export const DISPATCH_TABLE = {
  version: 1,
  classifier: {
    // source: zetetic-genius register.tsx, the request classifier: haiku at low effort, 1024 tokens of reply (Haiku
    // 5.5's adaptive thinking counts toward max_tokens; the JSON answer is under 60 tokens). Haiku 5.5 is "built for
    // high-volume, latency-sensitive work such as classification, routing" (route.ts sources).
    model: 'haiku',
    effort: 'low',
    maxTokens: 1024,
    // source: zetetic-genius classify.ts PROMPT_HEAD_CHARS, own choice there: the opening of a request names its task.
    promptHeadChars: 4000,
  },
  // A task that produces the work.
  rows: {
    routine: {
      model: 'sonnet',
      effort: 'low',
      source:
        'effort-calibration.md: reading, I/O, listing low; owner 2026-10-15 (dispatch-model-economy): haiku is never a default, only where the result is mechanically verified, and no mechanical predicate decides that yet',
    },
    planned: {
      model: 'sonnet',
      effort: 'low',
      source: 'effort-calibration.md: implementing a fully specified plan low; sonnet for agent planning and execution',
    },
    bugfix: {
      model: 'sonnet',
      effort: 'medium',
      source: 'effort-calibration.md: bug fix with clear root cause low-medium (the upper bound, as genius CLASS_EFFORT); dispatch-model-economy: specified fixes sonnet/medium',
    },
    analysis: {
      model: 'opus',
      effort: 'medium',
      source: 'effort-calibration.md: architecture decision, research synthesis medium; opus for deep multi-file work and designs with no spec',
    },
    critical: {
      model: 'opus',
      effort: 'high',
      source: 'effort-calibration.md: formal verification, concurrency proof, security audit high; opus for formal verification',
    },
  },
  // A task that reviews, audits or verifies work already written. Owner 2026-10-20 (auto-dispatch-owner-rules): a review
  // runs on opus when the task is complex, else on sonnet. Complex = analysis or critical (the classes whose work is a
  // design, a multi-file change or a load-bearing correctness claim): that reading is this table's.
  review: {
    routine: { model: 'sonnet', effort: 'medium', source: 'owner 2026-10-20: a review that is not complex runs on sonnet; dispatch-model-economy: delta reviews sonnet/medium' },
    planned: { model: 'sonnet', effort: 'medium', source: 'owner 2026-10-20: a review that is not complex runs on sonnet; dispatch-model-economy: delta reviews sonnet/medium' },
    bugfix: { model: 'sonnet', effort: 'medium', source: 'owner 2026-10-20: a review that is not complex runs on sonnet; dispatch-model-economy: delta reviews sonnet/medium' },
    analysis: { model: 'opus', effort: 'medium', source: 'owner 2026-10-20: a complex review runs on opus; effort-calibration.md: opus for code review, accurate at lower effort; a first review opus/medium' },
    critical: { model: 'opus', effort: 'high', source: 'owner 2026-10-20: a complex review runs on opus; effort-calibration.md: security audit, formal verification high' },
  },
} as const satisfies DispatchTable
