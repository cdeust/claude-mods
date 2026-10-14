import { expect, test } from 'claude-code/testing'

import { parseCeilings } from './calibration'

test('a version 1 calibration gives each phase its loop rung; another shape is refused with why', () => {
  expect(parseCeilings('{"version":1,"phases":{"test":"high","analysis":"low"},"evidence":{}}')).toEqual({ test: 'high', analysis: 'low' })
  expect(() => parseCeilings('{"phases":{}}')).toThrow(/not version 1/)
  expect(() => parseCeilings('{"version":1,"phases":{"test":"max"}}')).toThrow(/test has effort max/)
})
