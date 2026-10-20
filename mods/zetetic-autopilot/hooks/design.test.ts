import { expect, test } from 'claude-code/testing'

import { DESIGN_FIELD_CAP, parseDesign } from './design'

const BLOCK = `DESIGN
task: in zetetic-insights, keep each delegation
check: claude plugin test . passes
model: haiku · effort: low · why: a lookup
genius shape: conservation-accounting → lavoisier: balance the books

Do the work.`

test('parseDesign reads the exact block format', () => {
  expect(parseDesign(BLOCK)).toEqual({ model: 'haiku', effort: 'low', shape: 'conservation-accounting → lavoisier: balance the books' })
})

test('parseDesign reads model and effort on their own lines too', () => {
  expect(parseDesign('intro\nDESIGN\nmodel: opus\neffort: high\n')).toEqual({ model: 'opus', effort: 'high', shape: null })
})

test('parseDesign: no block is null, a partial block has null fields, a field after the block is not read', () => {
  expect(parseDesign('')).toBeNull()
  expect(parseDesign('design\nmodel: haiku')).toBeNull()
  expect(parseDesign('DESIGN\ntask: x\nmodel: sonnet')).toEqual({ model: 'sonnet', effort: null, shape: null })
  expect(parseDesign('DESIGN\ntask: x\n\nmodel: sonnet')).toEqual({ model: null, effort: null, shape: null })
  expect(parseDesign(`DESIGN\nmodel: ${'x'.repeat(200)}`)?.model?.length).toBe(DESIGN_FIELD_CAP)
  expect(parseDesign(undefined as never)).toBeNull()
})
