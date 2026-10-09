import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring: prompt.submit grades the request and, enforced, attaches the pattern; turn.start binds.

const TABLE = [
  '| Shape(s) | Skill | Description |',
  '|---|---|---|',
  '| estimation | estimation | Bound it before you build it. |',
].join('\n')
const INDEX = '| **falsifiability-gate** | "is this claim testable?" | [popper](popper.md) | Ask what would refute it |'
const INSTALLED = JSON.stringify({
  plugins: { 'zetetic-team-subagents@zetetic-marketplace': [{ installPath: '/p' }] },
})
const POPPER = [
  '---',
  'effort: medium',
  '---',
  '<identity>',
  'You are the Popper reasoning pattern: ask what would refute it.',
  '</identity>',
  '<workflow>',
  '1. Demarcation pass.',
  '</workflow>',
  '<output-format>',
  '### Falsifiability Analysis',
  '</output-format>',
].join('\n')

type Seen = { completions: number; context?: readonly string[] }

// The fake machine: the environment by name (HOME alone by default) and every path read.
type World = { env?: Record<string, string>; reads?: string[]; installed?: string }

const stubs = (on: Parameters<TestBody>[1], answer: string, seen: Seen, world: World = {}) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/r' }))
  const vars = world.env ?? { HOME: '/home/t' }
  on('env.get', ($, e) => ({ value: vars[String((e as { name?: string }).name ?? '')] as never }))
  on('fs.read', ($, e) => {
    const path = String((e as { path?: string }).path ?? '')
    world.reads?.push(path)
    if (path.endsWith('skill-routing-table.md')) return { value: TABLE }
    if (path.endsWith('installed_plugins.json')) return { value: world.installed ?? INSTALLED }
    if (path.endsWith('INDEX.md')) return { value: INDEX }
    if (path.endsWith('popper.md')) return { value: POPPER }
    return { deny: `no such file in the test: ${path}` }
  })
  on('model.complete', () => {
    seen.completions += 1
    return {
      value: {
        isAnswered: true,
        text: answer,
        usage: { input_tokens: 400, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never,
    }
  })
  on('prompt.submit', ($, e) => {
    seen.context = e.context
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
}

const PROMPT = { wait: false, origin: { kind: 'composer' } } as const
const GRADED = '{"task_class":"critical","shapes":[],"geniuses":[{"agent":"popper","shape":"falsifiability-gate"}]}'

test('observe: the request is graded once and the prompt goes through untouched', async ($, on) => {
  const seen: Seen = { completions: 0 }
  stubs(on, GRADED, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.prompt.submit({ ...PROMPT, text: 'Is the claim that the cache caused the speedup even testable?' } as never)
  expect(seen.completions).toBe(1)
  expect(seen.context).toBe(undefined)
})

test('enforce: the popper workflow rides beside the prompt', { options: { mode: 'enforce' } }, async ($, on) => {
  const seen: Seen = { completions: 0 }
  stubs(on, GRADED, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.prompt.submit({ ...PROMPT, text: 'Is the claim that the cache caused the speedup even testable?' } as never)
  expect(seen.context?.length).toBe(1)
  expect(seen.context?.[0]).toContain('apply the popper reasoning pattern')
  expect(seen.context?.[0]).toContain('1. Demarcation pass.')
  expect(seen.context?.[0]).toContain('/p/agents/genius/popper.md')
})

test('a slash command and an off-contract answer leave the prompt alone', { options: { mode: 'enforce' } }, async ($, on) => {
  const seen: Seen = { completions: 0 }
  stubs(on, 'critical, I think', seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.prompt.submit({ ...PROMPT, text: '/cortex' } as never)
  expect(seen.completions).toBe(0)
  await $.prompt.submit({ ...PROMPT, text: 'Explain why the consolidation job runs twice a night' } as never)
  expect(seen.completions).toBe(1)
  expect(seen.context).toBe(undefined)
})

// What the mod last wrote under its `state` key, read off the state.set it made.
const errorsOf = (on: Parameters<TestBody>[1]): { classifierError: string | null | undefined } => {
  const seen: { classifierError: string | null | undefined } = { classifierError: undefined }
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'state') seen.classifierError = (e as unknown as { value: { classifierError: string | null } }).value.classifierError
    return next(e)
  })
  return seen
}

test('the routing table and the installed plugins are read under CLAUDE_CONFIG_DIR when it is set', async ($, on) => {
  const reads: string[] = []
  stubs(on, GRADED, { completions: 0 }, { env: { HOME: '/home/t', CLAUDE_CONFIG_DIR: '/work/cfg' }, reads })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(reads).toContain('/work/cfg/reference/skill-routing-table.md')
  expect(reads).toContain('/work/cfg/plugins/installed_plugins.json')
  expect(reads.some((r) => r.startsWith('/home/t'))).toBe(false)
})

test('with no home the mod says the routing table has no place, instead of reading /.claude', async ($, on) => {
  const reads: string[] = []
  const seen = errorsOf(on)
  stubs(on, GRADED, { completions: 0 }, { env: {}, reads })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(reads).toEqual([])
  expect(seen.classifierError).toMatch(/no place: neither HOME nor USERPROFILE is set/)
})

test('an installed_plugins.json that is not JSON is reported as that, not as "not installed"', async ($, on) => {
  const seen = errorsOf(on)
  stubs(on, GRADED, { completions: 0 }, { installed: '{truncated' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(seen.classifierError).toMatch(/installed_plugins\.json is not valid JSON/)
  expect(seen.classifierError).not.toMatch(/is not installed/)
})
