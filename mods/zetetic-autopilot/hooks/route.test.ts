import { expect, test } from 'claude-code/testing'

import { familyOf, mainModelFor, routeAgentModel } from './route'

const FABLE = 'claude-fable-5-1'
const OPUS = 'claude-opus-5-5'

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
  expect(routeAgentModel('Explore', undefined, INHERIT, FABLE, 'none', 'routine')).toBe('haiku')
  expect(routeAgentModel('Explore', undefined, INHERIT, FABLE, 'none', 'planned')).toBe('haiku')
  expect(routeAgentModel('Explore', undefined, INHERIT, FABLE, 'none', 'analysis')).toBe('sonnet')
  expect(routeAgentModel('general-purpose', undefined, INHERIT, OPUS, 'none')).toBe('sonnet')
  expect(routeAgentModel('Plan', undefined, INHERIT, FABLE, 'none')).toBe('opus')
  expect(routeAgentModel('Plan', undefined, INHERIT, OPUS, 'none')).toBe(undefined)
})

test("a model the definition pins stands: the router never overrides the agent's author", () => {
  // advisor and orchestrator are defined on fable; under a fable parent they used to go to opus.
  expect(routeAgentModel('zetetic-team-subagents:advisor', undefined, { model: 'fable', effort: 'high' }, FABLE, 'none')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:orchestrator', undefined, { model: 'fable' }, FABLE, 'none')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:code-reviewer', undefined, SONNET_DEF, FABLE, 'none')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:engineer', undefined, SONNET_DEF, FABLE, 'none', 'planned')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:architect', undefined, { model: 'inherit' }, FABLE, 'none')).toBe('opus')
})

test('an explicit model, a sonnet or haiku parent, an unknown type and an unread definition route nothing', () => {
  expect(routeAgentModel('Explore', 'opus', undefined, FABLE, 'none', 'routine')).toBe(undefined)
  expect(routeAgentModel('Explore', undefined, INHERIT, 'claude-sonnet-5-5', 'none', 'routine')).toBe(undefined)
  expect(routeAgentModel('Explore', undefined, INHERIT, 'claude-haiku-5-5', 'none', 'routine')).toBe(undefined)
  expect(routeAgentModel('brand-voice:discover-brand', undefined, INHERIT, FABLE, 'none')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:engineer', undefined, undefined, FABLE, 'quota')).toBe(undefined)
})

test('pressure sends a heavy subagent one notch down from the model it would run on', () => {
  expect(routeAgentModel('zetetic-team-subagents:security-auditor', undefined, { model: 'opus' }, OPUS, 'quota')).toBe('sonnet')
  expect(routeAgentModel('zetetic-team-subagents:security-auditor', undefined, { model: 'opus' }, OPUS, 'none')).toBe(undefined)
  expect(routeAgentModel('Explore', 'opus', undefined, FABLE, 'context')).toBe('sonnet')
  expect(routeAgentModel('Explore', undefined, INHERIT, FABLE, 'quota')).toBe('sonnet')
  expect(routeAgentModel('Explore', 'haiku', undefined, FABLE, 'quota')).toBe(undefined)
})

test('pressure never raises: a haiku or sonnet definition under a heavy parent stays where it is', () => {
  // memory-writer, latex-engineer and professor are defined on haiku; pressure used to send them to sonnet.
  expect(routeAgentModel('zetetic-team-subagents:memory-writer', undefined, { model: 'haiku', effort: 'low' }, OPUS, 'quota')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:professor', undefined, { model: 'haiku' }, FABLE, 'context')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:engineer', undefined, SONNET_DEF, FABLE, 'quota')).toBe(undefined)
})

test('main drops to sonnet under quota pressure only, and only from opus or fable', () => {
  // A full id: the main step's model goes to the Messages API, which rejects the CLI alias.
  expect(mainModelFor(FABLE, 'quota')).toBe('claude-sonnet-5-5')
  expect(mainModelFor(OPUS, 'quota')).toBe('claude-sonnet-5-5')
  expect(mainModelFor(FABLE, 'context')).toBe(undefined)
  expect(mainModelFor('claude-sonnet-5-5', 'quota')).toBe(undefined)
  expect(mainModelFor('claude-haiku-5-5', 'quota')).toBe(undefined)
})
