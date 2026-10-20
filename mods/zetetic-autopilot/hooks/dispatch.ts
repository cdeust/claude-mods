// Pure half of the dispatch decision for one spawn: what its DESIGN block says, whether its task is classified, how the
// classifier is asked and read, and the rung the table (dispatch-table.ts) gives a class. Precedence per dimension,
// first match wins: explicit (call, definition, fork/workflow/teammate) > DESIGN > table (route.ts for the model,
// effort.ts for the effort). A failed classifier decides nothing; no pressure is an input here.
// source: ADR-9851

import { type Definition, pinnedModel } from './agents'
import { parseDesign } from './design'
import type { Effort } from './policy'
import { FAMILIES, type Family, type TaskClass } from './route'

// One rung of the table: the alias the Agent tool takes (AgentInput.model) and the effort its steps run at.
export type Rung = { readonly model: 'haiku' | 'sonnet' | 'opus'; readonly effort: Effort; readonly source: string }

export type DispatchTable = {
  readonly version: number
  readonly classifier: { readonly model: string; readonly effort: Effort; readonly maxTokens: number; readonly promptHeadChars: number }
  readonly rows: Readonly<Record<TaskClass, Rung>>
  readonly review: Readonly<Record<TaskClass, Rung>>
}

// Mirrors the zetetic-genius contract (its classify.ts TASK_CLASSES), in the order of the effort they call for.
export const TASK_CLASSES: readonly TaskClass[] = ['routine', 'planned', 'bugfix', 'analysis', 'critical']

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// What a DESIGN block decides: the one model family it names, the effort level it names; `refused` each value it
// stated that is neither (a DESIGN field is free text), named in a row and never guessed at.
export type Designed = { model?: Family; effort?: Effort; refused: string[] }

const familyNamed = (text: string): Family | undefined => {
  const t = text.toLowerCase()
  const named = FAMILIES.filter((f) => t.includes(f))
  return named.length === 1 ? named[0] : undefined
}

const effortNamed = (text: string): Effort | undefined => {
  const first = text.trim().toLowerCase().split(/[\s(,;]/)[0] ?? ''
  return EFFORTS.find((e) => e === first)
}

export const designOf = (prompt: string): Designed => {
  const block = parseDesign(prompt)
  if (block === null) return { refused: [] }
  const refused: string[] = []
  const model = block.model === null ? undefined : familyNamed(block.model)
  if (block.model !== null && model === undefined) refused.push(`model '${block.model}' names no single model family`)
  const effort = block.effort === null ? undefined : effortNamed(block.effort)
  if (block.effort !== null && effort === undefined) refused.push(`effort '${block.effort}' is not an effort level`)
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), refused }
}

// What the spawn tells before any completion: `seen` its Agent call was seen at tool.call (a hook's own spawn and a
// message resuming an agent are not), `resumed` it resumes an agent, `definition` undefined when it could not be read.
export type DispatchFacts = {
  fixed: boolean
  seen: boolean
  resumed: boolean
  callModel: string | undefined
  definition: Definition | undefined
  design: Designed
}

// The one case a completion is spent on: a model's own Agent call for an inheriting type (definition read, no model
// pin), naming no model, whose prompt designs neither model nor effort (a DESIGN of task, check and shape designs nothing).
export const classifiable = (f: DispatchFacts): boolean =>
  !f.fixed &&
  f.seen &&
  !f.resumed &&
  f.callModel === undefined &&
  f.definition !== undefined &&
  pinnedModel(f.definition) === undefined &&
  f.design.model === undefined &&
  f.design.effort === undefined

export type Classification = { cls: TaskClass; review: boolean }
// undefined: nobody asked; `failed`: asked, and no class came back (the reason, for the row).
export type Classified = Classification | { failed: string } | undefined

// The five class definitions are the zetetic-genius classifier's (classify.ts): a spawn and the request it came from
// are graded on one scale.
export const CLASSIFIER_SYSTEM = [
  'You classify one task an orchestrator hands to a coding subagent. Answer with one JSON object and nothing else:',
  '{"task_class": <class>, "review": <true or false>}',
  '',
  'task_class is exactly one of:',
  '- routine: reading, listing, searching, formatting, a one-line change, a question answered from files.',
  '- planned: implementing a plan or spec that is already written out in the request.',
  '- bugfix: a bug whose cause is clear or quickly located.',
  '- analysis: an architecture decision, a design, a research synthesis, a multi-file feature.',
  '- critical: formal correctness, concurrency, security, billing, data loss; a wrong answer is worse than a slow one.',
  '',
  'review is true when the task is to review, audit or verify work that already exists (code, a diff, a pull request,',
  'a document, a list of findings) and to report on it; false when the task produces the work itself.',
  'Grade the task the subagent is given, not the topic it touches.',
].join('\n')

// What the classifier reads: the agent type and the description (the orchestrator's summary), then the prompt's head.
export const classifierPrompt = (type: string, description: string, prompt: string, headChars: number): string =>
  `Agent type: ${type}\nDescription: ${description}\n\nTask:\n${prompt.slice(0, headChars)}`

// Strict: a JSON object, fenced or bare, with a known class and a boolean review; anything else is no class.
export const parseClass = (answer: string): Classification | undefined => {
  const match = /\{[\s\S]*\}/.exec(answer)
  if (match === null) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return undefined
  }
  const o = raw as { task_class?: unknown; review?: unknown } | null
  if (o === null || typeof o !== 'object') return undefined
  const cls = TASK_CLASSES.find((c) => c === o.task_class)
  if (cls === undefined || typeof o.review !== 'boolean') return undefined
  return { cls, review: o.review }
}

export const rungOf = (table: DispatchTable, c: Classification): Rung => (c.review ? table.review : table.rows)[c.cls]

export const rungName = (r: { model: string; effort: string }): string => `${r.model}/${r.effort}`

// What DESIGN or the table say once the explicit facts are set aside (route.ts and effort.ts put those first): the
// model and the effort to take, who said so, and for the table the class and the rung.
export type Steer =
  | { by: 'design'; model?: Family; effort?: Effort }
  | { by: 'table'; model: Rung['model']; effort: Effort; cls: TaskClass; review: boolean; rung: string }
  | { by: 'unclassified'; why: string }
  | { by: 'none' }

// DESIGN and the table steer only a model's own Agent call that starts an agent: never a fork, a workflow agent, a
// teammate, a spawn no Agent call was seen for, or a resume. A class given for a spawn that is not classifiable is
// not read.
export const steerOf = (f: DispatchFacts, table: DispatchTable, classified: Classified): Steer => {
  if (f.fixed || !f.seen || f.resumed) return { by: 'none' }
  if (f.design.model !== undefined || f.design.effort !== undefined) {
    return { by: 'design', ...(f.design.model === undefined ? {} : { model: f.design.model }), ...(f.design.effort === undefined ? {} : { effort: f.design.effort }) }
  }
  if (classified === undefined || !classifiable(f)) return { by: 'none' }
  if ('failed' in classified) return { by: 'unclassified', why: classified.failed }
  const r = rungOf(table, classified)
  return { by: 'table', model: r.model, effort: r.effort, cls: classified.cls, review: classified.review, rung: rungName(r) }
}
