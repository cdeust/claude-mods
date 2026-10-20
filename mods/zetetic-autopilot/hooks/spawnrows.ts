// The dispatch decision at the spawn, the side that reads the engine: the one classifier completion, DESIGN's refused
// values and a failed class as rows, and the row of a spawn whose model or steps the mod sets (dispatch.ts is pure).
// source: ADR-9851
import type { EngineInterface } from 'claude-code'

import type { PolicyDecision } from '../types'
import { CLASSIFIER_SYSTEM, type Classified, type DispatchFacts, type Steer, classifiable, classifierPrompt, designOf, parseClass, steerOf } from './dispatch'
import { DISPATCH_TABLE } from './dispatch-table'
import type { Decided } from './effort'
import type { TaskClass } from './route'

export type SpawnText = { subagentType: string; description: string; prompt: string }

// What DESIGN or the dispatch table say for this spawn, and the rows the caller logs: each DESIGN value that is no model
// family or effort level (`refused`, a note: subject and reason), and a classifier that gave no class (`row`). The
// table is consulted only when classifiable, through one completion.
export type Dispatched = { steer: Steer; refused: [string, string][]; row: PolicyDecision | undefined }

export async function dispatchOf($: EngineInterface, e: SpawnText, facts: Omit<DispatchFacts, 'design'>): Promise<Dispatched> {
  const design = facts.fixed || !facts.seen || facts.resumed ? { refused: [] } : designOf(e.prompt)
  const refused = design.refused.map((why): [string, string] => [`${e.subagentType} DESIGN`, why])
  const f: DispatchFacts = { ...facts, design }
  const steer = steerOf(f, DISPATCH_TABLE, classifiable(f) ? await classifySpawn($, e) : undefined)
  if (steer.by !== 'unclassified') return { steer, refused, row: undefined }
  const at = await $.clock.now()
  const reason = 'no class: the spawn inherits its model and effort'
  return { steer, refused, row: { at, kind: 'unread', subject: `${e.subagentType} task class`, from: 'dispatch table', to: steer.why, applied: false, reason } }
}

// One completion grades the spawn's task. No clock bounds it: an interrupt of the dispatch aborts it (`aborted`), and
// every way it ends without a class (an API error, an empty or off-contract reply, a refused request) is named, never
// answered with a default.
async function classifySpawn($: EngineInterface, e: SpawnText): Promise<Classified> {
  const c = DISPATCH_TABLE.classifier
  try {
    const r = await $.model.complete({
      model: c.model,
      effort: c.effort,
      maxTokens: c.maxTokens,
      system: CLASSIFIER_SYSTEM,
      prompt: classifierPrompt(e.subagentType, e.description, e.prompt, c.promptHeadChars),
    })
    if (!r.isAnswered) return { failed: r.reason === 'api-error' ? `api-error ${r.status ?? 'no response'} ${r.error}` : r.reason }
    return parseClass(r.text) ?? { failed: `answered off-contract: ${r.text.slice(0, 80)}` }
  } catch (error) {
    return { failed: `refused: ${String(error).slice(0, 100)}` }
  }
}

export type ModelRow = { type: string; steer: Steer; from: string; to: string; applied: boolean }

// The row of a spawn whose model DESIGN or the table rewrites.
export const modelRowOf = (at: number, r: ModelRow): PolicyDecision => {
  const what = r.steer.by === 'table' ? `${r.steer.cls}${r.steer.review ? ' review' : ''}` : 'DESIGN'
  const reason = r.steer.by === 'table' ? `${what} task: the table's rung ${r.steer.rung}` : `the DESIGN block names ${r.to}`
  return { at, kind: 'model', subject: `${r.type} · ${what}`, from: r.from, to: r.to, applied: r.applied, reason }
}

export type EffortRow = { type: string; cls: TaskClass | undefined; effort: Decided; applied: boolean }

// The row of a spawn whose steps the mod sets the effort of; the steps themselves log none.
export const effortRowOf = (at: number, r: EffortRow): PolicyDecision => {
  const subject = `${r.type}${r.cls === undefined ? '' : ` · ${r.cls}`} · every step`
  const from = r.effort.reason === 'grade' ? 'no call or definition effort' : r.effort.reason === 'table' ? 'the dispatch table' : 'the DESIGN block'
  return { at, kind: 'effort', subject, from, to: String(r.effort.effort), applied: r.applied }
}
