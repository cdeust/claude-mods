import { expect, test } from 'claude-code/testing'

import type { Definition } from './agents'
import {
  CLASSIFIER_SYSTEM,
  type Classified,
  type DispatchFacts,
  TASK_CLASSES,
  classifiable,
  classifierPrompt,
  designOf,
  parseClass,
  rungOf,
  steerOf,
} from './dispatch'
import { DISPATCH_TABLE } from './dispatch-table'
import { subagentEffort } from './effort'
import { routeAgentModel } from './route'

// The dispatch table and its precedence (ADR-9851), pure: each row, each guard, and the two owner rules.

const OPUS_PARENT = 'claude-opus-5-5' // source: the Opus 5.5 id, as route.test.ts spells the parent model

// Each row as shipped: a change to the table changes these lines too.
test('each row of the table: the class of a task that produces the work gives its rung', () => {
  const rows = TASK_CLASSES.map((cls) => [cls, rungOf(DISPATCH_TABLE, { cls, review: false })].map((x) => (typeof x === 'string' ? x : `${x.model}/${x.effort}`)))
  expect(rows).toEqual([
    ['routine', 'sonnet/low'],
    ['planned', 'sonnet/low'],
    ['bugfix', 'sonnet/medium'],
    ['analysis', 'opus/medium'],
    ['critical', 'opus/high'],
  ])
})

test('each review row: opus when the task is complex (analysis, critical), else sonnet (owner 2026-10-20)', () => {
  const rows = TASK_CLASSES.map((cls) => [cls, rungOf(DISPATCH_TABLE, { cls, review: true })].map((x) => (typeof x === 'string' ? x : `${x.model}/${x.effort}`)))
  expect(rows).toEqual([
    ['routine', 'sonnet/medium'],
    ['planned', 'sonnet/medium'],
    ['bugfix', 'sonnet/medium'],
    ['analysis', 'opus/medium'],
    ['critical', 'opus/high'],
  ])
})

test('no row is haiku (owner 2026-10-15: haiku is never a default) and every row names its source', () => {
  for (const r of [...Object.values(DISPATCH_TABLE.rows), ...Object.values(DISPATCH_TABLE.review)]) {
    expect(r.model).not.toBe('haiku')
    expect(r.source.length).toBeGreaterThan(20)
  }
  expect(Object.keys(DISPATCH_TABLE.rows).sort()).toEqual([...TASK_CLASSES].sort())
  expect(Object.keys(DISPATCH_TABLE.review).sort()).toEqual([...TASK_CLASSES].sort())
})

test('DESIGN: a model counts when it names one family, an effort when it is a level; any other value is refused, never guessed', () => {
  expect(designOf('DESIGN\nmodel: opus · effort: high · why: x')).toEqual({ model: 'opus', effort: 'high', refused: [] })
  expect(designOf('DESIGN\nmodel: claude-sonnet-5-5\neffort: Medium (bounded)')).toEqual({ model: 'sonnet', effort: 'medium', refused: [] })
  expect(designOf('DESIGN\nmodel: fable')).toEqual({ model: 'fable', refused: [] })
  expect(designOf('DESIGN\nmodel: sonnet or opus\neffort: whatever fits')).toEqual({
    refused: ["model 'sonnet or opus' names no single model family", "effort 'whatever fits' is not an effort level"],
  })
  expect(designOf('DESIGN\ntask: x\ncheck: y\ngenius shape: z')).toEqual({ refused: [] })
  expect(designOf('no block here')).toEqual({ refused: [] })
})

const INHERITING: DispatchFacts = { fixed: false, seen: true, resumed: false, callModel: undefined, definition: {}, design: { refused: [] } }

test('classifiable: only a seen Agent call for an inheriting type that nobody designed', () => {
  expect(classifiable(INHERITING)).toBe(true)
  expect(classifiable({ ...INHERITING, definition: { model: 'inherit', effort: 'high' } })).toBe(true)
  const guards: [string, Partial<DispatchFacts>][] = [
    ['fork, workflow agent or teammate', { fixed: true }],
    ['no Agent call seen', { seen: false }],
    ['a resume', { resumed: true }],
    ['the call names a model', { callModel: 'haiku' }],
    ['the definition is unread', { definition: undefined }],
    ['the definition pins a model', { definition: { model: 'sonnet' } as Definition }],
    ['DESIGN names a model', { design: { model: 'opus', refused: [] } }],
    ['DESIGN names an effort', { design: { effort: 'low', refused: [] } }],
  ]
  for (const [why, facts] of guards) expect([why, classifiable({ ...INHERITING, ...facts })]).toEqual([why, false])
})

const ANALYSIS: Classified = { cls: 'analysis', review: false }

test('steer: DESIGN before the table, the table only for a classifiable spawn, a failure decides nothing', () => {
  expect(steerOf(INHERITING, DISPATCH_TABLE, ANALYSIS)).toEqual({ by: 'table', model: 'opus', effort: 'medium', cls: 'analysis', review: false, rung: 'opus/medium' })
  expect(steerOf(INHERITING, DISPATCH_TABLE, { cls: 'bugfix', review: true })).toMatchObject({ by: 'table', model: 'sonnet', effort: 'medium', review: true })
  expect(steerOf({ ...INHERITING, design: { model: 'haiku', refused: [] } }, DISPATCH_TABLE, ANALYSIS)).toEqual({ by: 'design', model: 'haiku' })
  expect(steerOf(INHERITING, DISPATCH_TABLE, { failed: 'aborted' })).toEqual({ by: 'unclassified', why: 'aborted' })
  expect(steerOf(INHERITING, DISPATCH_TABLE, undefined)).toEqual({ by: 'none' })
  // A class handed in for a spawn that is not classifiable is not read.
  expect(steerOf({ ...INHERITING, callModel: 'sonnet' }, DISPATCH_TABLE, ANALYSIS)).toEqual({ by: 'none' })
  for (const facts of [{ fixed: true }, { seen: false }, { resumed: true }]) {
    expect(steerOf({ ...INHERITING, ...facts, design: { model: 'opus', refused: [] } }, DISPATCH_TABLE, ANALYSIS)).toEqual({ by: 'none' })
  }
})

// The whole decision for one spawn as register.tsx composes it, with every steer DESIGN or the table can produce.
const STEERS = [
  steerOf(INHERITING, DISPATCH_TABLE, ANALYSIS),
  steerOf(INHERITING, DISPATCH_TABLE, { cls: 'routine', review: false }),
  { by: 'design', model: 'haiku', effort: 'low' } as const,
  { by: 'design', model: 'fable' } as const,
  { by: 'unclassified', why: 'x' } as const,
  { by: 'none' } as const,
]

test('a pinned model is never rewritten: a call model or a definition pin stands against every steer', () => {
  for (const steer of STEERS) {
    for (const [call, definition] of [
      ['opus', {}],
      ['haiku', { model: 'sonnet' }],
      [undefined, { model: 'opus' }],
      [undefined, { model: 'haiku', effort: 'low' }],
    ] as [string | undefined, Definition][]) {
      const r = routeAgentModel(call, definition, OPUS_PARENT, steer)
      expect(r.model).toBe(undefined)
      expect(r.stands).toBe(call ?? definition.model)
    }
  }
})

test('pressure does not change the output: no input of the decision is a pressure, a quota or a context', () => {
  // steerOf (facts, table, class), routeAgentModel (call, definition, parent, steer), subagentEffort (facts): the facts
  // carry no pressure field, and the same facts give the same decision whatever the session's quota reads.
  expect(steerOf.length).toBe(3)
  expect(routeAgentModel.length).toBe(4)
  expect(subagentEffort.length).toBe(1)
  expect(Object.keys(INHERITING).sort()).toEqual(['callModel', 'definition', 'design', 'fixed', 'resumed', 'seen'])
  const once = steerOf(INHERITING, DISPATCH_TABLE, ANALYSIS)
  expect(steerOf(INHERITING, DISPATCH_TABLE, ANALYSIS)).toEqual(once)
})

test('the classifier answer is read strictly: a known class and a boolean review, fenced or bare', () => {
  expect(parseClass('{"task_class": "critical", "review": true}')).toEqual({ cls: 'critical', review: true })
  expect(parseClass('```json\n{"task_class":"planned","review":false}\n```')).toEqual({ cls: 'planned', review: false })
  for (const bad of ['', 'routine', '{"task_class": "routine"}', '{"task_class": "easy", "review": false}', '{"task_class": "routine", "review": "no"}', '{bad json}', 'null']) {
    expect([bad, parseClass(bad)]).toEqual([bad, undefined])
  }
})

test('the classifier reads the type, the description and the head of the prompt; its classes are the table\'s', () => {
  const p = classifierPrompt('Explore', 'find the parser', `start ${'x'.repeat(5000)}`, DISPATCH_TABLE.classifier.promptHeadChars)
  expect(p.startsWith('Agent type: Explore\nDescription: find the parser\n\nTask:\nstart ')).toBe(true)
  expect(p.length).toBe('Agent type: Explore\nDescription: find the parser\n\nTask:\n'.length + DISPATCH_TABLE.classifier.promptHeadChars)
  for (const cls of TASK_CLASSES) expect(CLASSIFIER_SYSTEM).toContain(`- ${cls}: `)
  expect(DISPATCH_TABLE.classifier).toMatchObject({ model: 'haiku', effort: 'low' })
})
