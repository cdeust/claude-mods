import { expect, test } from 'claude-code/testing'

test('the main loop is refused a work tool, a subagent is not', async ($, on) => {
  on('tool.call', () => ({ result: {} }))

  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)).deny).toBeUndefined()
})

test('warn mode lets the main loop through', { options: { main_mode: 'warn' } }, async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test('off mode touches nothing', { options: { main_mode: 'off' } }, async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test('an Agent call gets the mod\'s decision, a named pair is only a request, a fork is untouched', async ($, on) => {
  const seen: Array<{ model?: string; effort?: string }> = []
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent') seen.push({ model: e.model, effort: e.effort })
    return { result: {} }
  })

  // no fm in this test: the regex decides
  await $.tool.call({ tool: 'Agent', description: 'Crawl the docs', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', description: 'Crawl the docs', prompt: 'p', model: 'opus', effort: 'max' })
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'p', subagent_type: 'fork' })

  expect(seen[0]).toEqual({ model: 'haiku', effort: 'low' })
  expect(seen[1]).toEqual({ model: 'haiku', effort: 'low' })
  expect(seen[2]).toEqual({ model: undefined, effort: undefined })
})

const TRANSCRIPT = '/Users/x/.claude/projects/-Users-x-repo/s1/subagents/agent-a1.jsonl'
const LIFT = 'python3 /Users/x/.claude/plugins/cache/m/p/1.0.0/tools/reflection_ledger.py --cwd /Users/x/repo lift abc123 --memory-id 42'

test('block: the main loop may read a subagent transcript and run one lift, no more', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  expect((await $.tool.call({ tool: 'Read', file_path: TRANSCRIPT })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: LIFT })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: `${LIFT} && ${LIFT}` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: `${LIFT} | sh` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toMatch(/delegate/)

  // another path, a path that climbs out, a chained command, a lift with a tail
  expect((await $.tool.call({ tool: 'Read', file_path: '/Users/x/notes.txt' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Read', file_path: '/Users/x/.claude/projects/x/subagents/../../../../notes/a.jsonl' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: `${LIFT}; id` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: `${LIFT} && cat /etc/hosts` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: `${LIFT}\nid` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Write', file_path: TRANSCRIPT, content: 'x' })).deny).toMatch(/delegate/)
})

test('block: a read-only grep of a transcript and the ledger list pass, other Bash is refused', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const LIST = 'python3 /Users/x/.claude/plugins/cache/m/p/1.0.0/tools/reflection_ledger.py --cwd /Users/x/repo list'
  expect((await $.tool.call({ tool: 'Bash', command: `grep -c tool_use ${TRANSCRIPT}` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: LIST })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: `grep -c tool_use ${TRANSCRIPT} | sh` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: 'grep -c tool_use /etc/hosts' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: `${LIST}; id` })).deny).toMatch(/delegate/)
})

test('warn: the two reflection calls pass without a toast or a count, any other work tool is counted', { options: { main_mode: 'warn' } }, async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined as never }
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: TRANSCRIPT })
  await $.tool.call({ tool: 'Bash', command: LIFT })
  await $.tool.call({ tool: 'Bash', command: `${LIFT}; id` })
  expect(toasts).toEqual(['delegate: Bash on the main loop; delegate it'])
})

test('the system prompt gains the delegation section', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(out.sections.at(-1)?.id).toBe('delegate:rules')
})
