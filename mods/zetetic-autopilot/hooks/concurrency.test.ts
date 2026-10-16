import { expect, test } from 'claude-code/testing'

import { MAX_PARALLEL_AGENTS, MIN_PARALLEL_AGENTS, capStatus, fiveHourPercent, isRefused, parallelCap, refusalMessage, stillRunning } from './concurrency'

test('the cap falls in bands of 20 points from 5 to 1 across the default quota mark of 80', () => {
  const at = (u: number) => parallelCap(u, 80)
  expect([0, 0.1, 19.9].map(at)).toEqual([5, 5, 5])
  expect([20, 39.9].map(at)).toEqual([4, 4])
  expect([40, 59.9].map(at)).toEqual([3, 3])
  expect([60, 79.9].map(at)).toEqual([2, 2])
  expect([80, 90, 100].map(at)).toEqual([1, 1, 1])
})

test('the cap never rises with the use, and never leaves 1..max', () => {
  let before = Infinity
  for (let u = 0; u <= 100; u += 0.5) {
    const c = parallelCap(u, 80)
    expect(c).toBeLessThanOrEqual(before)
    expect(c).toBeGreaterThanOrEqual(MIN_PARALLEL_AGENTS)
    expect(c).toBeLessThanOrEqual(MAX_PARALLEL_AGENTS)
    before = c
  }
})

test('the quota mark moves the bands; a mark of 0 (or less) puts the cap at 1 under any use; an unread window limits nothing', () => {
  expect(parallelCap(50, 100)).toBe(3)
  expect(parallelCap(0, 0)).toBe(1)
  expect(parallelCap(10, -5)).toBe(1)
  expect(parallelCap(undefined, 80)).toBe(MAX_PARALLEL_AGENTS)
  expect(parallelCap(0, 80, 8)).toBe(8)
  expect(parallelCap(40, 80, 8)).toBe(5)
  // a configured maximum below 1 cannot lock the orchestrator out
  expect(parallelCap(0, 80, 0)).toBe(1)
  expect(parallelCap(undefined, 80, 0)).toBe(1)
})

test('a spawn is refused once the running agents fill the cap, and a cap of 1 always admits the first', () => {
  expect(isRefused(0, 1)).toBe(false)
  expect(isRefused(1, 1)).toBe(true)
  expect(isRefused(4, 5)).toBe(false)
  expect(isRefused(5, 5)).toBe(true)
})

test('the refusal names the running count, the cap, the quota and the way out', () => {
  const m = refusalMessage(2, 2, 71.4, 80)
  expect(m).toContain('2 subagents are running')
  expect(m).toContain('cap is 2')
  expect(m).toContain('71%')
  expect(m).toContain('five-hour window')
  expect(m).toContain('Wait for a running agent to finish')
  expect(refusalMessage(1, 1, 95, 80)).toContain('1 subagent is running')
  expect(refusalMessage(1, 1, undefined, 80)).toContain('an unread share')
})

test('the status for the user states the same numbers as the refusal and leaves out the way out', () => {
  const s = capStatus('x:engineer', 2, 2, 71.4, 80)
  expect(s).toContain('spawn of x:engineer refused')
  expect(s).toContain('2 subagents running')
  expect(s).toContain('cap 2 at 71%')
  expect(s).toContain('five-hour window')
  expect(s).not.toMatch(/wait|again/i)
  expect(capStatus('x', 1, 1, 95, 80)).toContain('1 subagent running')
  expect(capStatus('x', 1, 1, undefined, 80)).toContain('an unread share')
})

test('the five-hour window is read out of the rate limits, and only that one', () => {
  expect(fiveHourPercent([{ kind: 'seven_day', percentUsed: 90 }, { kind: 'five_hour', percentUsed: 12 }])).toBe(12)
  expect(fiveHourPercent([{ kind: 'seven_day', percentUsed: 90 }])).toBe(undefined)
})

test('the engine list confirms the running agents: ended, killed and unknown ones do not hold a slot', () => {
  const listed = [
    { id: 'a', status: 'running' as const },
    { id: 'b', status: 'killed' as const },
    { id: 'c', status: 'completed' as const },
    { id: 'd', status: 'waiting' as const },
    { id: 'e', status: 'pending' as const },
    { id: 'f', status: 'idle' as const },
  ]
  expect(stillRunning(['a', 'b', 'c', 'd', 'e', 'f', 'gone'], listed)).toEqual(['a', 'd', 'e'])
})
