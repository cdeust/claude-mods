// The classifier half of scripts/replay-dispatch.mjs: each request line (built there by the autopilot's own functions)
// goes through $.model.complete, the call zetetic-autopilot's spawnrows.ts makes, and its answer is written as a line.
import type { EngineInterface, Register } from 'claude-code'

type Line = { agentId: string; request: { model: string; effort: 'low'; maxTokens: number; system: string; prompt: string } }

async function classifyAll($: EngineInterface, args: string): Promise<string> {
  const [input, output] = args.trim().split(/\s+/)
  if (input === undefined || output === undefined) return 'usage: /replay-classify <requests.jsonl> <answers.jsonl>'
  const lines = String(await $.fs.read(input)).split('\n').filter((l) => l.trim() !== '')
  const answers: string[] = []
  for (const l of lines) {
    const { agentId, request } = JSON.parse(l) as Line
    try {
      const r = await $.model.complete(request)
      answers.push(JSON.stringify(r.isAnswered ? { agentId, isAnswered: true, text: r.text } : { agentId, isAnswered: false, reason: r.reason }))
    } catch (error) {
      answers.push(JSON.stringify({ agentId, isAnswered: false, reason: `refused: ${String(error).slice(0, 100)}` }))
    }
  }
  await $.fs.write(output, `${answers.join('\n')}\n`)
  return `${answers.length} answers written to ${output}`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'replay-classify', description: 'Classify replay requests', argumentHint: '<requests.jsonl> <answers.jsonl>', immediate: true })
    return next(e)
  })
  on('command.run', { command: 'replay-classify' }, async ($, e) => ({ text: await classifyAll($, e.args ?? '') }))
}
