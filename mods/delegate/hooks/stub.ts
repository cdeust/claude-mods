// Test support: stands in for the three things the mod reaches out to (`process.run`, `http.fetch`, `clock.sleep`)
// and for the Agent call itself. Imported by tests only; hooks.json loads register.tsx alone.

import type { TestBody } from 'claude-code/testing'

export type Dollar = Parameters<TestBody>[0]
export type On = Parameters<TestBody>[1]

// A reply of the fm process, or an Error: a rejection, as the engine rejects a command that cannot start.
export type FmReply = { exitCode: number; stdout?: string; stderr?: string } | Error
// A reply of the HTTP API, or an Error (the request failed before an answer).
export type NetReply = { status: number; text: string } | Error
export type Call = { argv: readonly string[]; stdin?: string; timeoutMs?: number }
export type Net = { url: string; method?: string; headers?: Record<string, string>; body?: string }

export const fmSays = (cls: string, reason = 'because'): FmReply => ({ exitCode: 0, stdout: JSON.stringify({ class: cls, reason }) })
export const jevSays = (cls: string, confidence = 0.9): NetReply => ({
  status: 200,
  text: JSON.stringify({ model: 'jev-1.14.0', answers: { route: { type: 'choice', choice: cls, confidence, probabilities: { [cls]: confidence } } } }),
})
export const ABSENT = new Error('HooksError: delegate: $.process.run(/usr/bin/fm) failed to start: ENOENT: no such file or directory')
export const TIMEOUT = new Error('HooksError: delegate: $.process.run(/usr/bin/fm) aborted: still running after 4000ms')

const fmResult = (r: FmReply) =>
  r instanceof Error ? { deny: r.message } : { value: { stdout: '', stderr: '', ...r, isStdoutTruncated: false, isStderrTruncated: false } }
const netResult = (r: NetReply) => (r instanceof Error ? { deny: r.message } : { value: { ok: r.status >= 200 && r.status < 300, headers: {}, ...r } })

export type Wiring = {
  fm?: FmReply[] // replies in order, the last repeating; absent: fm is not answered at all (the call is denied)
  net?: NetReply[] // same for http.fetch
  asks?: string[] // answers of the user's dialog, in order; absent: nobody can be asked (a -p run)
  // The user's answer to each question of an AskUserQuestion call; undefined: the user declined (the call is denied).
  choose?: (question: string) => string | undefined
  stateDown?: true // `state.get` is refused: every read of the mod's atoms rejects
  faultOnAgent?: true // the Agent call throws beneath the mod, as a fault in a lower hook would
}

// Wires the stubs and returns what the mod sent through them. `sleep` never fires unless `fire()` is called.
export function wire(on: On, w: Wiring = {}) {
  const calls: Call[] = []
  const nets: Net[] = []
  const sent: Array<{ model?: string; effort?: string }> = []
  const logs: string[] = []
  const sleeps: Array<() => void> = []
  const fm = w.fm ?? [ABSENT]
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })
    return fmResult(fm[Math.min(calls.length - 1, fm.length - 1)] as FmReply)
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  if (w.stateDown) on('state.get', () => ({ deny: 'state is down' }))
  const net = w.net ?? []
  on('http.fetch', (_, e) => {
    nets.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: e.init?.body })
    return netResult(net[Math.min(nets.length - 1, net.length - 1)] ?? new Error('no reply wired'))
  })
  on('clock.sleep', () => new Promise((resolve) => sleeps.push(() => resolve({ value: undefined as never }))))
  on('ui.log', (_, e) => {
    logs.push(String((e as unknown as { text?: string }).text ?? ''))
    return { value: undefined as never }
  })
  const answers = [...(w.asks ?? [])]
  const questions: string[] = []
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent' && w.faultOnAgent) throw new Error('boom')
    if (e.tool === 'Agent') sent.push({ model: e.model, effort: e.effort })
    if (e.tool === 'AskUserQuestion') {
      questions.push(JSON.stringify(e))
      if (w.choose !== undefined) {
        const answers: Record<string, string> = {}
        for (const q of (e as unknown as { questions: Array<{ question: string }> }).questions) {
          const a = w.choose(q.question)
          if (a === undefined) return { deny: 'no one to ask' }
          answers[q.question] = a
        }
        return { result: { answers } } as never
      }
      if (w.asks === undefined) return { deny: 'no one to ask' }
      const a = answers.shift() ?? 'low'
      return { result: { answers: { [String((e as unknown as { questions: Array<{ question: string }> }).questions[0]?.question)]: a } } } as never
    }
    return { result: {} }
  })
  return { calls, nets, sent, logs, questions, fire: () => sleeps.splice(0).forEach((f) => f()) }
}

let n = 0
export const spawn = ($: Dollar, fields: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Agent', tool_use_id: `t${++n}`, description: 'Do the task', prompt: 'p', ...fields } as never)

export const PANE = {
  plugin: 'delegate',
  component: 'Pane',
  requestId: 'delegate',
  surface: 'terminal',
  props: { title: 'Delegation', isFocused: false, bodyColumns: 240, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

// What the pane shows per row: the line (decided pair, who decided, what was asked) and its reason.
export async function pane($: Dollar) {
  const ui = await $.ui.mount(PANE as never)
  const lines = (await ui.findAll({ type: 'Text', text: /\[(fm|jev|fm\+jev|user|caller|none)\]/ })).map((x) => x.text)
  const reasons = (await ui.findAll({ type: 'Text', text: /↳/ })).map((x) => x.text)
  await ui.unmount()
  return { lines, reasons }
}
