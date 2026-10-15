import { expect, test } from 'claude-code/testing'

import { DEFAULT_PREVIEW_CHARS, DEFAULT_THRESHOLD_CHARS, PART_CHARS, offloadOptions, parts, planOffload, previewOf, toolResultsDir } from './offload'

const OPTIONS = { thresholdChars: 1000, previewChars: 200 }
const DIR = '/home/t/.claude/projects/-r/sess-1/tool-results'

// SHA-256 of the UTF-8 bytes of a string, hex.
const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')

test('a result within the threshold is left as it is, one past it is offloaded', () => {
  expect(planOffload('x'.repeat(1000), 'toolu_1', DIR, OPTIONS)).toBe(undefined)
  expect(planOffload('x'.repeat(1001), 'toolu_1', DIR, OPTIONS)).toBeDefined()
})

test('the file holds the result byte for byte; the text shown is a preview, the path and the size', async () => {
  const text = lines(400)
  const plan = planOffload(text, 'toolu_01AB', DIR, OPTIONS)
  expect(plan?.files.length).toBe(1)
  expect(plan?.files[0]?.path).toBe(`${DIR}/autopilot-toolu_01AB.txt`)
  expect(await sha256(plan?.files[0]?.text ?? '')).toBe(await sha256(text))
  expect(plan?.files[0]?.text === text).toBe(true)
  const message = plan?.message ?? ''
  expect(message).toContain(`Full output saved to: ${DIR}/autopilot-toolu_01AB.txt`)
  expect(message).toContain(`${String(text.length).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} characters, 400 lines`)
  expect(message).toContain('Read or grep the file for the rest')
  expect(message).toContain(text.slice(0, 100))
  expect(message.length < text.length / 4).toBe(true)
  expect(message).not.toContain('cut')
  expect(message).not.toContain('truncated')
})

test("the engine's own pointers are not wrapped again, however long", () => {
  const long = 'y'.repeat(5000)
  expect(planOffload(`<persisted-output>\nOutput too large (49 KB). Full output saved to: /p\n${long}`, 't', DIR, OPTIONS)).toBe(undefined)
  expect(planOffload(`<truncated-output>${long}`, 't', DIR, OPTIONS)).toBe(undefined)
})

test('a result past the engine file limit is split in parts that join to the result', async () => {
  const text = 'ab'.repeat(1_250_000) // 2 500 000 characters
  const plan = planOffload(text, 'toolu_big', DIR, OPTIONS)
  expect(plan?.files.map((f) => f.path)).toEqual([
    `${DIR}/autopilot-toolu_big.1.txt`,
    `${DIR}/autopilot-toolu_big.2.txt`,
    `${DIR}/autopilot-toolu_big.3.txt`,
  ])
  expect((plan?.files ?? []).every((f) => f.text.length <= PART_CHARS)).toBe(true)
  const joined = (plan?.files ?? []).map((f) => f.text).join('')
  expect(await sha256(joined)).toBe(await sha256(text))
  for (const f of plan?.files ?? []) expect(plan?.message).toContain(f.path)
})

test('a surrogate pair is never split between two parts or inside the preview', () => {
  const emoji = '\u{1F600}'
  const text = 'a'.repeat(PART_CHARS - 1) + emoji + 'b'.repeat(10)
  const pieces = parts(text)
  expect(pieces.length).toBe(2)
  expect(pieces.join('') === text).toBe(true)
  expect(pieces[0]?.endsWith(emoji)).toBe(false)
  expect(pieces[1]?.startsWith(emoji)).toBe(true)
  expect(previewOf(`${'a'.repeat(9)}${emoji}${'b'.repeat(50)}`, 10)).toBe('a'.repeat(9))
})

test('the preview ends at a line break when one falls in its second half, else at the limit', () => {
  expect(previewOf('aaaa\nbbbb\ncccc\n', 12)).toBe('aaaa\nbbbb')
  expect(previewOf(`a\n${'b'.repeat(30)}`, 10)).toBe(`a\n${'b'.repeat(8)}`)
  expect(previewOf('short', 100)).toBe('short')
})

test('the session directory is the one the transcript names, for that session only', () => {
  const transcript = '/home/t/.claude/projects/-r/sess-1.jsonl'
  expect(toolResultsDir(transcript, 'sess-1')).toBe(DIR)
  expect(toolResultsDir(transcript, 'sess-2')).toBe(undefined)
  expect(toolResultsDir(undefined, 'sess-1')).toBe(undefined)
  expect(toolResultsDir('/home/t/.claude/projects/-r/sess-1.json', 'sess-1')).toBe(undefined)
  expect(toolResultsDir('C:\\Users\\t\\.claude\\projects\\r\\sess-1.jsonl', 'sess-1')).toBe('C:\\Users\\t\\.claude\\projects\\r\\sess-1\\tool-results')
  const win = planOffload('z'.repeat(2000), 'toolu_w', 'C:\\s\\tool-results', OPTIONS)
  expect(win?.files[0]?.path).toBe('C:\\s\\tool-results\\autopilot-toolu_w.txt')
})

test('the transcript stem must equal the session id and climb nowhere', () => {
  expect(toolResultsDir('/home/t/.claude/projects/-r/xsess-1.jsonl', 'sess-1')).toBe(undefined)
  expect(toolResultsDir('/home/t/.claude/projects/-r/sess-1x.jsonl', 'sess-1')).toBe(undefined)
  expect(toolResultsDir('/home/t/.claude/projects/../../etc/sess-1.jsonl', 'sess-1')).toBe(undefined)
  expect(toolResultsDir('C:\\p\\..\\q\\sess-1.jsonl', 'sess-1')).toBe(undefined)
  expect(toolResultsDir('/home/t/.claude/projects/-r/sess-1.jsonl', 'sess-1')).toBe(DIR)
})

test('a tool_use id that is not a file name is made one', () => {
  const plan = planOffload('z'.repeat(2000), '../../etc/passwd', DIR, OPTIONS)
  expect(plan?.files[0]?.path).toBe(`${DIR}/autopilot-______etc_passwd.txt`)
})

test('options: the defaults, a value that is not a positive whole number named, a preview past the threshold clamped', () => {
  expect(offloadOptions(undefined, undefined)).toEqual({
    options: { thresholdChars: DEFAULT_THRESHOLD_CHARS, previewChars: DEFAULT_PREVIEW_CHARS },
    problems: [],
  })
  const bad = offloadOptions(Number.NaN, -5)
  expect(bad.options).toEqual({ thresholdChars: DEFAULT_THRESHOLD_CHARS, previewChars: DEFAULT_PREVIEW_CHARS })
  expect(bad.problems.length).toBe(2)
  const clamped = offloadOptions(500, 900)
  expect(clamped.options).toEqual({ thresholdChars: 500, previewChars: 500 })
  expect(clamped.problems.length).toBe(1)
  expect(offloadOptions(0, undefined).problems.length).toBe(1)
})

test('several text blocks joined: the message says so', () => {
  expect(planOffload('z'.repeat(2000), 't', DIR, OPTIONS, true)?.message).toContain('joined by a newline')
  expect(planOffload('z'.repeat(2000), 't', DIR, OPTIONS)?.message).not.toContain('joined by a newline')
})
