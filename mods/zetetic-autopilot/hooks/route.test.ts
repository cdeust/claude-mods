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

test('search subagents that inherit: haiku on a mechanical turn, sonnet otherwise', () => {
  expect(routeAgentModel('Explore', undefined, INHERIT, FABLE, 'routine')).toBe('haiku')
  expect(routeAgentModel('Explore', undefined, INHERIT, FABLE, 'planned')).toBe('haiku')
  expect(routeAgentModel('Explore', undefined, INHERIT, FABLE, 'analysis')).toBe('sonnet')
  expect(routeAgentModel('general-purpose', undefined, INHERIT, OPUS)).toBe('sonnet')
  expect(routeAgentModel('Plan', undefined, INHERIT, FABLE)).toBe('opus')
  expect(routeAgentModel('Plan', undefined, INHERIT, OPUS)).toBe(undefined)
})

test("a model the definition pins stands: the router never overrides the agent's author", () => {
  // advisor and orchestrator are defined on fable; under a fable parent they used to go to opus.
  expect(routeAgentModel('zetetic-team-subagents:advisor', undefined, { model: 'fable', effort: 'high' }, FABLE)).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:orchestrator', undefined, { model: 'fable' }, FABLE)).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:code-reviewer', undefined, SONNET_DEF, FABLE)).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:engineer', undefined, SONNET_DEF, FABLE, 'planned')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:architect', undefined, { model: 'inherit' }, FABLE)).toBe('opus')
})

test('an explicit model, a sonnet or haiku parent, an unknown type and an unread definition route nothing', () => {
  expect(routeAgentModel('Explore', 'opus', undefined, FABLE, 'routine')).toBe(undefined)
  expect(routeAgentModel('Explore', undefined, INHERIT, 'claude-sonnet-5-5', 'routine')).toBe(undefined)
  expect(routeAgentModel('Explore', undefined, INHERIT, 'claude-haiku-5-5', 'routine')).toBe(undefined)
  expect(routeAgentModel('brand-voice:discover-brand', undefined, INHERIT, FABLE)).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:engineer', undefined, undefined, FABLE)).toBe(undefined)
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
  // routeAgentModel takes (type, call, definition, parent, class): five parameters, none a pressure.
  expect(route.length).toBe(5)
  expect(route('zetetic-team-subagents:security-auditor', undefined, { model: 'opus' }, OPUS)).toMatchObject({ model: undefined, stands: 'opus', reason: 'definition' })
  expect(route('zetetic-team-subagents:engineer', 'opus', SONNET_DEF, OPUS)).toMatchObject({ model: undefined, stands: 'opus', reason: 'call' })
})

test('the route names what stands and why for each way a model is decided', () => {
  expect(route('zetetic-team-subagents:engineer', 'opus', SONNET_DEF, OPUS)).toMatchObject({ requested: 'opus', definition: 'sonnet', stands: 'opus', reason: 'call' })
  expect(route('zetetic-team-subagents:code-reviewer', undefined, SONNET_DEF, OPUS)).toMatchObject({ requested: null, definition: 'sonnet', stands: 'sonnet', reason: 'definition' })
  expect(route('zetetic-team-subagents:architect', undefined, { model: 'inherit' }, OPUS)).toMatchObject({ definition: null, stands: `inherit ${OPUS}`, reason: 'inherit' })
  expect(route('Explore', undefined, INHERIT, FABLE, 'routine')).toMatchObject({ model: 'haiku', reason: 'kind' })
  expect(route('zetetic-team-subagents:engineer', undefined, undefined, FABLE)).toMatchObject({ model: undefined, stands: `inherit ${FABLE}`, reason: 'unread' })
})
