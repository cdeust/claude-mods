import { expect, test } from 'claude-code/testing'

import { HALF_WIDTH, Z, isResolved, newcombe, stepsFor, wilson } from './stats'

const near = (x: number, y: number, tol = 0.0006) => expect(Math.abs(x - y)).toBeLessThan(tol)

test('the z is the one-sided 95% normal quantile', () => {
  near(Z, 1.6449, 0.0005)
})

test('wilson: known values at 95% two-sided (z 1.96): 5 of 10, 0 of 20, 20 of 20', () => {
  const half = wilson(5, 10, 1.96)
  near(half.lo, 0.2366)
  near(half.hi, 0.7634)
  const none = wilson(0, 20, 1.96)
  expect(none.lo).toBe(0)
  near(none.hi, 0.1611)
  const all = wilson(20, 20, 1.96)
  near(all.lo, 0.8389)
  expect(all.hi).toBe(1)
})

test('wilson: no trials knows nothing; the interval contains the rate and stays inside [0, 1]', () => {
  expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 1, n: 0 })
  for (const [k, n] of [[1, 3], [3, 3], [0, 1], [17, 60], [60, 60]] as const) {
    const iv = wilson(k, n)
    expect(iv.lo).toBeGreaterThanOrEqual(0)
    expect(iv.hi).toBeLessThanOrEqual(1)
    expect(iv.lo).toBeLessThanOrEqual(iv.p + 1e-12)
    expect(iv.hi).toBeGreaterThanOrEqual(iv.p - 1e-12)
  }
})

test("newcombe: the paper's example 56/70 against 48/80 gives 0.2000 (0.0524, 0.3339) at 95%", () => {
  const d = newcombe({ k: 56, n: 70 }, { k: 48, n: 80 }, 1.96)
  near(d.d, 0.2, 1e-9)
  near(d.lo, 0.0524, 0.0005)
  near(d.hi, 0.3339, 0.0005)
})

test('newcombe: identical samples centre on zero; a side with no trials is as wide as it can be', () => {
  const same = newcombe({ k: 10, n: 50 }, { k: 10, n: 50 })
  expect(same.d).toBe(0)
  expect(same.lo).toBeLessThan(0)
  expect(same.hi).toBeGreaterThan(0)
  const blind = newcombe({ k: 0, n: 40 }, { k: 0, n: 0 })
  expect(blind.hi - blind.lo).toBeGreaterThan(newcombe({ k: 0, n: 40 }, { k: 0, n: 40 }).hi - newcombe({ k: 0, n: 40 }, { k: 0, n: 40 }).lo)
})

test('stepsFor: the steps that resolve a rate to +-10 points; 51 at a quarter, the old 40 was too few', () => {
  expect(HALF_WIDTH).toBe(0.1)
  expect(stepsFor(0.25)).toBe(51)
  expect(stepsFor(0.05)).toBe(13)
  expect(stepsFor(0.5)).toBe(68)
  // the derivation holds: at that many steps the interval is about as narrow as asked
  const iv = wilson(Math.round(0.25 * 51), 51)
  expect((iv.hi - iv.lo) / 2).toBeLessThanOrEqual(HALF_WIDTH)
  const short = wilson(Math.round(0.25 * 40), 40)
  expect((short.hi - short.lo) / 2).toBeGreaterThan(HALF_WIDTH)
})

test('isResolved: narrow enough or not; no trials is never resolved', () => {
  expect(isResolved(wilson(13, 51))).toBe(true)
  expect(isResolved(wilson(3, 12))).toBe(false)
  expect(isResolved(wilson(0, 0))).toBe(false)
})
