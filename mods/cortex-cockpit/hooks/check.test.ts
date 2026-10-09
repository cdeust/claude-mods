import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// /cortex check through the engine: the command hook, the checks, and the text they return. The
// machine is mocked at the engine's own nouns (process, fs, env, mcp, state, config, command);
// each test changes the one thing under test and reads its line.

type Answer<T> = T | { deny: string }

type World = {
  python?: Answer<{ exitCode: number; stdout: string; stderr: string }>
  gh?: Answer<{ exitCode: number; stdout: string; stderr: string }>
  script?: 'file' | { deny: string }
  files?: Record<string, string | { deny: string }>
  memoryStats?: Answer<{ content: { type: 'text'; text: string }[]; isError: boolean }>
  config?: Answer<{ key: string; value: unknown; isLocked: boolean }[]>
  commands?: string[]
  stateRefusal?: string
  // Leave state to the engine, which keeps the cockpit's own atoms truthfully.
  isStateReal?: boolean
}

const STATS = JSON.stringify({
  total_memories: 12,
  episodic_count: 1,
  semantic_count: 1,
  active_count: 1,
  archived_count: 0,
  stale_count: 0,
  protected_count: 0,
  avg_heat: 0.5,
  total_entities: 1,
  total_relationships: 1,
  active_triggers: 0,
  last_consolidation: null,
  has_vector_search: true,
  grooming_staleness: {},
  grooming_staleness_threshold_days: 7,
})
const OK = { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' }
const RATE = { exitCode: 0, stdout: JSON.stringify({ resources: { core: { remaining: 4990, limit: 5000 } } }), stderr: '' }
const HOME = '/home/t'
const SCRIPT = `${HOME}/Developments/disk-hygiene/disk_hygiene.py`
const GENIUS = { mode: 'observe', classifierModel: 'haiku' }
const POLICY = { mode: 'enforce', quotaPercent: 80, resultCapChars: 16000 }
const ROWS = [
  { key: 'cortex-guard.hygiene_script', value: '~/Developments/disk-hygiene/disk_hygiene.py', isLocked: false },
  { key: 'harness-fleet.github_owner', value: 'cdeust', isLocked: true },
]

const wrap = (answer: unknown): never => ((answer as { deny?: string }).deny !== undefined ? answer : { value: answer }) as never

const install = (on: Parameters<TestBody>[1], world: World): void => {
  mock.clock(on, { now: 1_000_000 })
  on('env.get', () => ({ value: HOME }))
  on('config.list', () => wrap(world.config ?? ROWS))
  on('command.list', () => ({ value: (world.commands ?? ['cortex', 'wiki', 'fleet']).map((name) => ({ name })) }) as never)
  on('process.run', ($, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === 'python3') return wrap(world.python ?? OK)
    if (argv[0] === 'gh' && argv[1] === 'api') return wrap(world.gh ?? RATE)

    return wrap({ exitCode: 0, stdout: `${argv[0]} ok`, stderr: '' })
  })
  on('fs.stat', ($, e) => {
    if (e.path !== SCRIPT) return { deny: `no stat in the test: ${e.path}` }
    const script = world.script ?? 'file'

    return script === 'file' ? ({ value: { kind: 'file', size: 1, mtimeMs: 0 } } as never) : script
  })
  on('fs.read', ($, e) => {
    const file = (world.files ?? {})[e.path] ?? '{}'

    return typeof file === 'string' ? { value: file } : file
  })
  on('mcp.call', () => wrap(world.memoryStats ?? { content: [{ type: 'text' as const, text: STATS }], isError: false }))
  if (world.isStateReal !== true) {
    on('state.get', ($, e) => {
      if (world.stateRefusal !== undefined) return { deny: world.stateRefusal }
      const plugin = (e as { plugin?: string }).plugin
      const value = plugin === 'zetetic-genius' ? GENIUS : plugin === 'zetetic-autopilot' ? POLICY : undefined

      return { value: { value, version: 0 } as never }
    })
  }
}

// What a person's `/cortex <args>` carries into the hook.
const typed = (args: string) => ({
  command: 'cortex',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const check = async ($: Parameters<TestBody>[0]): Promise<string> => (await $.command.run(typed('check'))).text ?? ''

const lineOf = (text: string, name: string): string => text.split('\n').find((l) => l.includes(name)) ?? `(no line for ${name})`

test('every check passes on a machine that answers', async ($, on) => {
  install(on, {})
  const text = await check($)
  expect(text).toMatch(/^\/cortex check: every check passed, reads only/)
  expect(lineOf(text, 'python3 (cortex-guard)')).toBe('ok    python3 (cortex-guard): Python 3.12.1')
  expect(lineOf(text, 'hygiene script')).toBe(`ok    hygiene script (cortex-guard): ${SCRIPT} exists`)
  expect(lineOf(text, 'Cortex MCP server')).toMatch(/^ok {4}Cortex MCP server plugin_hypermnesia-mcp_cortex: memory_stats answers, 12 memories/)
  expect(lineOf(text, 'gh api rate_limit')).toMatch(/^ok {4}gh api rate_limit: api.github.com answers, core 4990\/5000 left/)
  expect(lineOf(text, 'mod cortex-guard')).toMatch(/^ok {4}mod cortex-guard: loaded/)
})

test('a refusal from the machine reaches the line as its first 160 characters', async ($, on) => {
  const refusal = 'error connecting to api.github.com: dial tcp: lookup api.github.com: blocked by the sandbox policy of the company, ask the security team for an exception ' + 'x'.repeat(100)
  install(on, { gh: { exitCode: 4, stdout: '', stderr: `${refusal}\nsecond line` } })
  const text = await check($)
  const line = lineOf(text, 'gh api rate_limit')
  expect(line.startsWith('FAIL  gh api rate_limit: exit 4: error connecting to api.github.com')).toBe(true)
  expect(line.endsWith(refusal.slice(0, 160))).toBe(true)
  expect(line).not.toContain('second line')
  expect(text).toMatch(/1 failed/)
})

test('a command the sandbox refuses to start is shown with its text', async ($, on) => {
  install(on, { python: { deny: 'sandbox-exec: python3 is not in the allow list' } })
  expect(lineOf(await check($), 'python3 (cortex-guard)')).toMatch(/^FAIL {2}python3 \(cortex-guard\): python3 --version could not start: .*not in the allow list/)
})

test('a python3 that exits non-zero shows its exit code and stderr', async ($, on) => {
  install(on, { python: { exitCode: 127, stdout: '', stderr: 'python3: command not found' } })
  expect(lineOf(await check($), 'python3 (cortex-guard)')).toBe('FAIL  python3 (cortex-guard): exit 127: python3: command not found')
})

test('a missing hygiene script is named with its path and the cause', async ($, on) => {
  install(on, { script: { deny: `ENOENT: no such file or directory, stat '${SCRIPT}'` } })
  expect(lineOf(await check($), 'hygiene script')).toMatch(/^FAIL {2}hygiene script \(cortex-guard\): not found at \/home\/t\/Developments\/disk-hygiene\/disk_hygiene\.py: .*ENOENT/)
})

test('an empty hygiene option is reported as disabled on purpose, not as a failure', async ($, on) => {
  install(on, { config: [{ key: 'cortex-guard.hygiene_script', value: '', isLocked: false }] })
  expect(lineOf(await check($), 'hygiene script')).toMatch(/^n\/a {3}hygiene script \(cortex-guard\): option is empty/)
})

test('with no readable hygiene option the default location is checked and said so', async ($, on) => {
  install(on, { config: [] })
  expect(lineOf(await check($), 'hygiene script')).toBe(`ok    hygiene script (cortex-guard): ${SCRIPT} exists (option not readable here, so its default location is checked)`)
})

test('an MCP server that answers with an error shows the server text', async ($, on) => {
  install(on, { memoryStats: { content: [{ type: 'text', text: 'server not connected: plugin_hypermnesia-mcp_cortex' }], isError: true } })
  expect(lineOf(await check($), 'Cortex MCP server')).toBe('FAIL  Cortex MCP server plugin_hypermnesia-mcp_cortex: memory_stats: server not connected: plugin_hypermnesia-mcp_cortex')
})

test('an MCP call the engine refuses shows the refusal', async ($, on) => {
  install(on, { memoryStats: { deny: 'no such MCP server: plugin_hypermnesia-mcp_cortex' } })
  expect(lineOf(await check($), 'Cortex MCP server')).toMatch(/^FAIL {2}Cortex MCP server .*: memory_stats call refused: .*no such MCP server/)
})

test('the files the fleet reads: a refused read shows the refusal, a readable one its size', async ($, on) => {
  install(on, { files: { [`${HOME}/.claude/plugins/known_marketplaces.json`]: { deny: 'EPERM: operation not permitted, open' } } })
  const text = await check($)
  expect(lineOf(text, 'installed_plugins.json')).toBe('ok    fleet file ~/.claude/plugins/installed_plugins.json: readable, 2 characters')
  expect(lineOf(text, 'known_marketplaces.json')).toMatch(/^FAIL {2}fleet file ~\/\.claude\/plugins\/known_marketplaces\.json: .*EPERM/)
})

test('a mod whose command is not registered reads as not loaded', async ($, on) => {
  install(on, { commands: ['cortex'] })
  const text = await check($)
  expect(lineOf(text, 'mod harness-fleet')).toBe('FAIL  mod harness-fleet: not loaded: /fleet is not registered')
  expect(lineOf(text, 'mod cortex-wiki')).toBe('FAIL  mod cortex-wiki: not loaded: /wiki is not registered')
  expect(lineOf(text, 'mod cortex-cockpit')).toMatch(/^ok {4}mod cortex-cockpit: loaded/)
})

test('a state key the engine refuses to read shows the refusal', async ($, on) => {
  install(on, { stateRefusal: 'state.get refused by policy' })
  expect(lineOf(await check($), 'mod zetetic-genius')).toMatch(/^FAIL {2}mod zetetic-genius: state key unreadable: .*refused by policy/)
})

test('options come from /config rows with their lock, else from the state the mod publishes', async ($, on) => {
  install(on, {})
  const text = await check($)
  expect(lineOf(text, 'option harness-fleet')).toBe('ok    option harness-fleet (as /config lists them): github_owner="cdeust" [locked by a trusted source]')
  expect(lineOf(text, 'option zetetic-genius')).toBe('ok    option zetetic-genius (as the mod states them): mode="observe" classifier_model="haiku"')
  expect(lineOf(text, 'option zetetic-autopilot')).toBe('ok    option zetetic-autopilot (as the mod states them): policy_mode="enforce" quota_pressure_percent=80 result_cap_chars=16000')
  expect(lineOf(text, 'option cortex-cockpit')).toContain('surface="ink" cortex_server="plugin_hypermnesia-mcp_cortex"')
})

test('options of a mod that publishes none and has no row read as not readable', async ($, on) => {
  install(on, { config: [] })
  expect(lineOf(await check($), 'option cortex-guard')).toMatch(/^n\/a {3}option cortex-guard: not readable/)
})

test('a refused config read shows the refusal and the checks that need no option still run', async ($, on) => {
  install(on, { config: { deny: 'config.list refused by policy' } })
  const text = await check($)
  expect(lineOf(text, 'options in /config')).toMatch(/^FAIL {2}options in \/config: \$\.config\.list refused: .*refused by policy/)
  expect(lineOf(text, 'python3 (cortex-guard)')).toMatch(/^ok/)
})

test('the model aliases are reported as not checked, never faked', async ($, on) => {
  install(on, {})
  const line = lineOf(await check($), 'models')
  expect(line).toMatch(/^n\/a {3}models: not checked/)
  expect(line).toContain('"haiku"')
})

// The pane's reads run in the background after the command answers; the test waits for the last
// two writes they make (the stats error slot and the hygiene snapshot), the events that end them.
test('/cortex without an argument still opens the pane', async ($, on) => {
  install(on, { isStateReal: true })
  const written = new Set<string>()
  let settled: () => void = () => undefined
  const both = new Promise<void>((resolve) => (settled = resolve))
  on('ui.open', () => ({ value: undefined }) as never)
  on('state.set', (_$, e, next) => {
    written.add(String((e as { key?: string }).key))
    if (written.has('statsError') && written.has('hygiene')) settled()
    return next(e)
  })
  expect((await $.command.run(typed(''))).text).toBe('Cortex cockpit opened.')
  await both
})
