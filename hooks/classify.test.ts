import { expect, test } from 'claude-code/testing'

import {
  classifierSystem,
  effortForClass,
  escalate,
  isClassifiable,
  parseClassification,
  parseShapes,
  shapeContext,
} from './classify'

const TABLE = [
  '# Skill Shape Routing Table — generated, do not edit',
  '',
  '| Shape(s) | Skill | Description |',
  '|---|---|---|',
  '| causal-audit | causal-audit | Correlation walked in; make it prove causation. Use when someone claims "X causes Y" |',
  '| estimation | estimation | Bound it before you build it. Use when a decision is blocked by "we don\'t have data" |',
  '| failure-forensics | failure-forensics | Read the wreckage before rebuilding. |',
].join('\n')

const shapes = parseShapes(TABLE)

test('the shape table yields one shape per row, header and rule skipped', () => {
  expect(shapes.map((s) => s.id)).toEqual(['causal-audit', 'estimation', 'failure-forensics'])
  expect(shapes[0]?.description.startsWith('Correlation walked in')).toBe(true)
  expect(parseShapes('')).toEqual([])
})

test('the system prompt lists every shape and the JSON contract', () => {
  const system = classifierSystem(shapes)
  expect(system).toContain('"task_class"')
  expect(system).toContain('- estimation: Bound it before you build it.')
  expect(system).toContain('- critical:')
})

test('a strict answer parses; an unknown class or shape voids it', () => {
  expect(parseClassification('{"task_class":"routine","shapes":[]}', shapes)).toEqual({
    taskClass: 'routine',
    shapes: [],
  })
  expect(
    parseClassification('```json\n{"task_class":"analysis","shapes":["causal-audit","causal-audit"]}\n```', shapes),
  ).toEqual({ taskClass: 'analysis', shapes: ['causal-audit'] })
  expect(parseClassification('{"task_class":"hard","shapes":[]}', shapes)).toBe(undefined)
  expect(parseClassification('{"task_class":"bugfix","shapes":["popper"]}', shapes)).toBe(undefined)
  expect(parseClassification('sure, routine', shapes)).toBe(undefined)
  const three = '{"task_class":"critical","shapes":["causal-audit","estimation","failure-forensics"]}'
  expect(parseClassification(three, shapes)?.shapes.length).toBe(2)
})

test('each class maps to the effort-calibration table', () => {
  expect(effortForClass('routine')).toBe('low')
  expect(effortForClass('planned')).toBe('low')
  expect(effortForClass('bugfix')).toBe('medium')
  expect(effortForClass('analysis')).toBe('medium')
  expect(effortForClass('critical')).toBe('high')
})

test('slash commands, plugin submits and short continuations are not classified', () => {
  const composer = { kind: 'composer' }
  expect(isClassifiable('/cortex', composer)).toBe(false)
  expect(isClassifiable('yes, go on', composer)).toBe(false)
  expect(isClassifiable('Did the cache change actually cause the latency drop?', { kind: 'plugin' })).toBe(false)
  expect(isClassifiable('Did the cache change actually cause the latency drop?', composer)).toBe(true)
})

test('the shape context names the skills to invoke first', () => {
  const text = shapeContext(['causal-audit', 'estimation'])
  expect(text).toContain('zetetic-team-subagents:causal-audit')
  expect(text).toContain('zetetic-team-subagents:estimation')
})

test('stuck raises one notch and stops at high', () => {
  expect(escalate('low')).toBe('medium')
  expect(escalate('medium')).toBe('high')
  expect(escalate('high')).toBe('high')
  expect(escalate('xhigh')).toBe('xhigh')
})
