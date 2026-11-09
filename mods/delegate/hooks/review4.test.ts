// Round 4 of the review of #56 (reviewer's probe P5, adapted; finding R4-1): the half of B8 that no test covered.
// When the decision itself fails (the pending asks cannot be read), the call is refused, a row says so, and the error
// does not escape the hook.
import { expect, test } from 'claude-code/testing'

import { pane, spawn } from './stub'
import type { On } from './stub'

const D = 'Review the guard'

// A layer beneath the mod: fm answers `read`, and every read of the `asks` atom is refused.
function below(on: On) {
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ class: 'read', reason: 'r' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('http.fetch', () => ({ deny: 'no net' }))
  on('clock.sleep', () => new Promise(() => undefined))
  on('ui.log', () => ({ value: undefined as never }))
  on('state.get', (_, e, next) => ((e as unknown as { key?: unknown }).key === 'asks' ? { deny: 'asks is down' } : next(e)))
  on('tool.call', (_, e) => (e.tool === 'AskUserQuestion' ? { deny: 'no one to ask' } : { result: {} }))
}

test('P5 (B8, decide fails) the asks atom is unreadable: the call is refused and a row says so', async ($, on) => {
  below(on)
  const out = (await spawn($, { description: D, model: 'fable', effort: 'max' })) as { deny?: string }
  expect(out.deny).toMatch(/AskUserQuestion/)
  const { lines, reasons } = await pane($)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatch(/^✗ .*\[none\]/)
  expect(reasons[0]).toMatch(/the decision failed/)
})
