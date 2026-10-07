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

test('search subagents: haiku on a mechanical turn, sonnet otherwise', () => {
  expect(routeAgentModel('Explore', undefined, FABLE, 'none', 'routine')).toBe('haiku')
  expect(routeAgentModel('Explore', undefined, FABLE, 'none', 'planned')).toBe('haiku')
  expect(routeAgentModel('Explore', undefined, FABLE, 'none', 'analysis')).toBe('sonnet')
  expect(routeAgentModel('general-purpose', undefined, OPUS, 'none')).toBe('sonnet')
})

test('coding subagents: haiku only when the plan is written, else sonnet', () => {
  expect(routeAgentModel('zetetic-team-subagents:engineer', undefined, FABLE, 'none', 'planned')).toBe('haiku')
  expect(routeAgentModel('zetetic-team-subagents:engineer', undefined, FABLE, 'none', 'routine')).toBe('sonnet')
  expect(routeAgentModel('zetetic-team-subagents:refactorer', undefined, OPUS, 'none', 'analysis')).toBe('sonnet')
})

test('review subagents stay heavy: opus under a fable parent, kept under opus', () => {
  expect(routeAgentModel('zetetic-team-subagents:code-reviewer', undefined, FABLE, 'none')).toBe('opus')
  expect(routeAgentModel('zetetic-team-subagents:security-auditor', undefined, FABLE, 'none', 'critical')).toBe('opus')
  expect(routeAgentModel('Plan', undefined, OPUS, 'none')).toBe(undefined)
  expect(routeAgentModel('zetetic-team-subagents:advisor', undefined, OPUS, 'none')).toBe(undefined)
})

test('an explicit model, a sonnet or haiku parent, and an unknown type route nothing', () => {
  expect(routeAgentModel('Explore', 'opus', FABLE, 'none', 'routine')).toBe(undefined)
  expect(routeAgentModel('Explore', undefined, 'claude-sonnet-5-5', 'none', 'routine')).toBe(undefined)
  expect(routeAgentModel('Explore', undefined, 'claude-haiku-5-5', 'none', 'routine')).toBe(undefined)
  expect(routeAgentModel('brand-voice:discover-brand', undefined, FABLE, 'none')).toBe(undefined)
})

test('pressure sends every heavy subagent one notch down, whatever its type', () => {
  expect(routeAgentModel('zetetic-team-subagents:code-reviewer', undefined, FABLE, 'quota')).toBe('sonnet')
  expect(routeAgentModel('Explore', 'opus', FABLE, 'context')).toBe('sonnet')
  expect(routeAgentModel('Explore', 'haiku', FABLE, 'quota')).toBe(undefined)
})

test('main drops to sonnet under quota pressure only, and only from opus or fable', () => {
  expect(mainModelFor(FABLE, 'quota')).toBe('sonnet')
  expect(mainModelFor(OPUS, 'quota')).toBe('sonnet')
  expect(mainModelFor(FABLE, 'context')).toBe(undefined)
  expect(mainModelFor('claude-sonnet-5-5', 'quota')).toBe(undefined)
  expect(mainModelFor('claude-haiku-5-5', 'quota')).toBe(undefined)
})
