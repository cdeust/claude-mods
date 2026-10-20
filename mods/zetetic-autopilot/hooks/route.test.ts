import { expect, test } from 'claude-code/testing'

import { familyOf, mainModelFor, routeAgentModel as route } from './route'

const FABLE = 'claude-fable-5-1'
const OPUS = 'claude-opus-5-5'

// The rewrite alone: undefined is "the call stands as it is".
const routeAgentModel = (...args: Parameters<typeof route>) => route(...args).model

test('families are matched by substring, alias or full id of any release', () => {
  expect(familyOf('haiku')).toBe('haiku')
  expect(familyOf('claude-haiku-4-5-20251001')).toBe('haiku')
  expect(familyOf('claude-haiku-5-5')).toBe('haiku')
  expect(familyOf('claude-sonnet-5-5')).toBe('sonnet')
  expect(familyOf(OPUS)).toBe('opus')
  expect(familyOf(FABLE)).toBe('fable')
  expect(familyOf('gpt-x')).toBe(undefined)
})

// An inheriting type (the built-ins, a definition with no model line) pins nothing.
const INHERIT = {}
const SONNET_DEF = { model: 'sonnet', effort: 'medium' }
const NONE = { by: 'none' } as const
const TABLE = { by: 'table', model: 'opus', effort: 'medium', cls: 'analysis', review: false, rung: 'opus/medium' } as const
const DESIGN = { by: 'design', model: 'haiku' } as const

// The type is no input of the router (0.11.0): the regex routing by kind is gone, the table decides by the task.
test('an inheriting type nothing steers runs on the parent\'s model', () => {
  expect(routeAgentModel(undefined, INHERIT, FABLE, NONE)).toBe(undefined)
  expect(route(undefined, INHERIT, FABLE, NONE)).toMatchObject({ reason: 'inherit', stands: `inherit ${FABLE}` })
})

test('DESIGN and the table steer an inheriting type: the rewrite and its reason', () => {
  expect(route(undefined, INHERIT, FABLE, TABLE)).toMatchObject({ model: 'opus', reason: 'table' })
  expect(route(undefined, { model: 'inherit' }, OPUS, DESIGN)).toMatchObject({ model: 'haiku', reason: 'design' })
  // A DESIGN that names only an effort leaves the model to the parent.
  expect(route(undefined, INHERIT, OPUS, { by: 'design', effort: 'low' })).toMatchObject({ model: undefined, reason: 'inherit' })
  expect(route(undefined, INHERIT, OPUS, { by: 'unclassified', why: 'api-error' })).toMatchObject({ model: undefined, reason: 'unclassified' })
})

test("a pinned model is never rewritten: neither DESIGN nor the table overrides the call or the agent's author", () => {
  for (const steer of [TABLE, DESIGN, NONE]) {
    expect(routeAgentModel(undefined, { model: 'fable', effort: 'high' }, FABLE, steer)).toBe(undefined)
    expect(routeAgentModel(undefined, SONNET_DEF, FABLE, steer)).toBe(undefined)
    expect(routeAgentModel('opus', SONNET_DEF, FABLE, steer)).toBe(undefined)
    expect(routeAgentModel('haiku', INHERIT, FABLE, steer)).toBe(undefined)
    expect(route(undefined, SONNET_DEF, FABLE, steer)).toMatchObject({ stands: 'sonnet', reason: 'definition' })
    expect(route('haiku', INHERIT, FABLE, steer)).toMatchObject({ stands: 'haiku', reason: 'call' })
  }
})

test('an unread definition with no call model decides nothing, whatever the steer', () => {
  expect(route(undefined, undefined, FABLE, TABLE)).toMatchObject({ model: undefined, stands: `inherit ${FABLE}`, reason: 'unread' })
})

test('main drops to sonnet under quota pressure only, and only from opus or fable', () => {
  // A full id: the main step's model goes to the Messages API, which rejects the CLI alias.
  expect(mainModelFor(FABLE, 'quota')).toBe('claude-sonnet-5-5')
  expect(mainModelFor(OPUS, 'quota')).toBe('claude-sonnet-5-5')
  expect(mainModelFor(FABLE, 'context')).toBe(undefined)
  expect(mainModelFor('claude-sonnet-5-5', 'quota')).toBe(undefined)
  expect(mainModelFor('claude-haiku-5-5', 'quota')).toBe(undefined)
})

test('the router has no pressure input: a designed model cannot be lowered by one (owner rule 2026-10-15)', () => {
  // routeAgentModel takes (call, definition, parent, steer): four parameters, none a pressure.
  expect(route.length).toBe(4)
  expect(route(undefined, { model: 'opus' }, OPUS, NONE)).toMatchObject({ model: undefined, stands: 'opus', reason: 'definition' })
  expect(route('opus', SONNET_DEF, OPUS, NONE)).toMatchObject({ model: undefined, stands: 'opus', reason: 'call' })
})

test('the route names what stands and why for each way a model is decided', () => {
  expect(route('opus', SONNET_DEF, OPUS, NONE)).toMatchObject({ requested: 'opus', definition: 'sonnet', stands: 'opus', reason: 'call' })
  expect(route(undefined, SONNET_DEF, OPUS, NONE)).toMatchObject({ requested: null, definition: 'sonnet', stands: 'sonnet', reason: 'definition' })
  expect(route(undefined, { model: 'inherit' }, OPUS, NONE)).toMatchObject({ definition: null, stands: `inherit ${OPUS}`, reason: 'inherit' })
  expect(route(undefined, INHERIT, FABLE, TABLE)).toMatchObject({ model: 'opus', reason: 'table' })
  expect(route(undefined, undefined, FABLE, NONE)).toMatchObject({ model: undefined, stands: `inherit ${FABLE}`, reason: 'unread' })
})
