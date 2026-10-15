import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { sessionModels } from './models'
import { isUnderTemp, probeOf, probesOf, tempProjectDir, withoutProbes } from './probes'

const turn = (session: string, at: number, steps: number, extra: Partial<TurnRecord> = {}): TurnRecord => ({
  session,
  turnId: `t${at}`,
  at,
  taskClass: null,
  main: [{ phase: 'implementation', effort: 'low', steps, errors: 0 }],
  agents: [],
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
  mainModel: 'claude-sonnet-5-5',
  ...extra,
})

test('temp dirs: the OS roots and the process TMPDIR, not a lookalike', () => {
  expect(isUnderTemp('/private/tmp')).toBe(true)
  expect(isUnderTemp('/private/tmp/claude-501/x')).toBe(true)
  expect(isUnderTemp('/var/folders/ab/cd/T/probe')).toBe(true)
  expect(isUnderTemp('/tmpfoo/x')).toBe(false)
  expect(isUnderTemp('/Users/me/proj/tmp')).toBe(false)
  expect(isUnderTemp('/scratch/run/1', ['/scratch/run/'])).toBe(true)
  expect(isUnderTemp('/x', [''])).toBe(false)
})

test('the transcript folder encodes the cwd: temp roots only', () => {
  expect(tempProjectDir('/Users/me/.claude/projects/-private-tmp/8d7fc62d.jsonl')).toBe(true)
  expect(tempProjectDir('/Users/me/.claude/projects/-private-tmp-claude-501-x/8d7fc62d.jsonl')).toBe(true)
  expect(tempProjectDir('/Users/me/.claude/projects/-Users-me-Developments-tmp-tool/8d7fc62d.jsonl')).toBe(false)
  expect(tempProjectDir('/Users/me/.claude/projects/-Users-me-proj/8d7fc62d.jsonl')).toBe(false)
})

test('a temp cwd is a probe whatever its length; a -p run of one step is; a -p run of five is work', () => {
  expect(probeOf([turn('s', 1, 90, { tmpCwd: true })])).toMatchObject({ probe: true, reason: 'temp-cwd' })
  expect(probeOf([turn('s', 1, 1, { nonInteractive: true })])).toMatchObject({ probe: true, reason: 'non-interactive-1-step' })
  expect(probeOf([turn('s', 1, 5, { nonInteractive: true })])).toMatchObject({ probe: false, reason: null })
})

test('a record stamped interactive, even one step, is work: the origin is known; unstamped it is unknown', () => {
  expect(probeOf([turn('s', 1, 1, { nonInteractive: false })])).toMatchObject({ probe: false, reason: null })
  expect(probeOf([turn('s', 1, 1)])).toMatchObject({ probe: true, reason: 'one-step-unknown' })
})

test('unknown origin: a single main step with no agent is a probe; three steps in one turn, or two turns of five, are work', () => {
  expect(probeOf([turn('s', 1, 3)]).probe).toBe(false)
  expect(probeOf([turn('s', 1, 3), turn('s', 2, 2)])).toMatchObject({ probe: false, steps: 5 })
  expect(probeOf([{ ...turn('s', 1, 1), agents: [{ type: 'x', phase: null, model: 'm', steps: 1, errors: 0 }] }]).probe).toBe(false)
})

test('the transcript path of an old ledger marks a temp session even when the records are unstamped', () => {
  expect(probeOf([turn('s', 1, 40)], '/u/.claude/projects/-private-tmp/s.jsonl')).toMatchObject({ probe: true, reason: 'temp-cwd' })
})

test('probesOf decides per session; withoutProbes drops theirs; sessionModels flags them and keeps them out of the 12', () => {
  const records = [turn('probe', 1, 1), turn('work', 2, 40)]
  const decided = probesOf(records)
  expect(withoutProbes(records, decided).map((r) => r.session)).toEqual(['work'])
  const rows = sessionModels(records, decided)
  expect(rows.map((r) => [r.session, r.probe, r.probeReason])).toEqual([
    ['work', false, null],
  ])
  const newer = sessionModels([turn('work', 2, 40), turn('probe', 3, 1)], probesOf([turn('work', 2, 40), turn('probe', 3, 1)]))
  expect(newer.map((r) => [r.session, r.probe, r.probeReason])).toEqual([
    ['work', false, null],
    ['probe', true, 'one-step-unknown'],
  ])
  const crowded = Array.from({ length: 20 }, (_, i) => turn(`p${i}`, i, 1))
  expect(sessionModels([turn('real', 100, 50), ...crowded], probesOf([turn('real', 100, 50), ...crowded])).map((r) => r.session)).toEqual(['real'])
})
