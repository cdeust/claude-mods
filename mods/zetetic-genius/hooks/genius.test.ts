import { expect, test } from 'claude-code/testing'

import { geniusContext, identityOpening, installPathOf, parseGeniusIndex, patternEffort, sectionOf } from './genius'

const INDEX = [
  '# Genius Agent Index — Route by Problem Shape',
  '',
  '### Measurement, Signal, and Isolation',
  '',
  '| Shape | Trigger | Agent | Key move |',
  '|---|---|---|---|',
  '| **residual-with-a-carrier** | measured > predicted from known parts, gap outside noise | [curie](curie.md) | Chase the excess; isolate by enrichment |',
  '| **falsifiability-gate** | "is this claim testable?" | [popper](popper.md) | Ask what would refute it |',
].join('\n')

const POPPER = [
  '---',
  'name: popper',
  'model: opus',
  'effort: medium',
  'shapes: [falsifiability-gate]',
  '---',
  '',
  '<identity>',
  'You are the Popper reasoning pattern: **before accepting any claim, ask what would refute it**.',
  '',
  'The historical figure is Karl Raimund Popper (1902-1994).',
  '</identity>',
  '<workflow>',
  '1. **Demarcation pass.** Classify every claim: testable or untestable?',
  '2. **Falsification conditions.** Name the observation that would refute it.',
  '</workflow>',
  '<output-format>',
  '### Falsifiability Analysis (Popper format)',
  '</output-format>',
  '<canonical-moves>',
  'long text that stays in the file',
  '</canonical-moves>',
].join('\n')

test('INDEX.md rows yield shape, trigger, agent and key move; headers carry none', () => {
  const rows = parseGeniusIndex(INDEX)
  expect(rows.length).toBe(2)
  expect(rows[1]).toEqual({
    shape: 'falsifiability-gate',
    trigger: '"is this claim testable?"',
    agent: 'popper',
    keyMove: 'Ask what would refute it',
  })
})

test('the installed plugin path comes from installed_plugins.json, never a versioned guess', () => {
  const json = JSON.stringify({
    plugins: { 'zetetic-team-subagents@zetetic-marketplace': [{ installPath: '/p/2.41.0', version: '2.41.0' }] },
  })
  expect(installPathOf(json, 'zetetic-team-subagents@zetetic-marketplace')).toBe('/p/2.41.0')
  expect(installPathOf(json, 'other@m')).toBe(undefined)
  expect(() => installPathOf('not json', 'other@m')).toThrow(/installed_plugins\.json is not valid JSON/)
})

test('a pattern file gives its sections, its identity opening and its own effort', () => {
  expect(sectionOf(POPPER, 'workflow')?.startsWith('1. **Demarcation pass.**')).toBe(true)
  expect(sectionOf(POPPER, 'missing')).toBe(undefined)
  expect(identityOpening(POPPER)).toContain('ask what would refute it')
  expect(identityOpening(POPPER)).not.toContain('historical figure')
  expect(patternEffort(POPPER)).toBe('medium')
})

test('the injected context carries the procedure, the matched shapes and the file path, not the canonical moves', () => {
  const text = geniusContext('popper', POPPER, parseGeniusIndex(INDEX), '/p/agents/genius/popper.md')
  expect(text).toContain('apply the popper reasoning pattern')
  expect(text).toContain('Shape falsifiability-gate: "is this claim testable?". Key move: Ask what would refute it')
  expect(text).toContain('1. **Demarcation pass.**')
  expect(text).toContain('### Falsifiability Analysis (Popper format)')
  expect(text).toContain('/p/agents/genius/popper.md')
  expect(text).not.toContain('long text that stays in the file')
  expect(text).not.toContain('residual-with-a-carrier')
})
