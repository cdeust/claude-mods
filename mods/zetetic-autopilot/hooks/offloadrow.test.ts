import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { type Block, type Context, offloadBlocks } from './offloadrow'

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// A machine whose files are a map; `session.id` is sess-1.
const machine = (files: Map<string, string>): EngineInterface =>
  ({
    session: { id: async () => 'sess-1' },
    fs: {
      exists: async (path: string) => files.has(path),
      write: async (path: string, text: string) => void files.set(path, text),
    },
  }) as unknown as EngineInterface

const ctx = (): Context => ({
  options: { thresholdChars: 100, previewChars: 20 },
  enforce: true,
  transcriptPath: '/p/proj/sess-1.jsonl',
  sink: { note: async () => {}, offloaded: async () => {} },
})

const long = (c: string): Block => ({ type: 'tool_result', content: c.repeat(300) })

test('two blocks without a tool_use id in one row write two distinct files, each whole', async () => {
  const files = new Map<string, string>()
  const out = await offloadBlocks(machine(files), 'row-1', 'Bash', [long('a'), long('b')], ctx())
  expect(out).not.toBe(undefined)
  expect(files.size).toBe(2)
  const written = [...files.values()].sort()
  expect(await sha256(written[0] ?? '')).toBe(await sha256('a'.repeat(300)))
  expect(await sha256(written[1] ?? '')).toBe(await sha256('b'.repeat(300)))
})

test('an existing file is never overwritten: the next free name is used', async () => {
  const files = new Map<string, string>()
  const block = { ...long('c'), tool_use_id: 'toolu_x' }
  await offloadBlocks(machine(files), 'row-1', 'Bash', [block], ctx())
  await offloadBlocks(machine(files), 'row-1', 'Bash', [{ ...long('d'), tool_use_id: 'toolu_x' }], ctx())
  expect(files.size).toBe(2)
  expect([...files.values()].sort()).toEqual(['c'.repeat(300), 'd'.repeat(300)])
})
