import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// /cortex check through the engine: the command hook, the checks, and the text they return. The
// machine is mocked at the engine's own nouns (process, fs, env, mcp, state, config, command);
// each test changes the one thing under test and reads its line.

type Answer<T> = T | { deny: string }

type Ran = { exitCode: number; stdout: string; stderr: string }

type World = {
  // The three pythons the guard tries, by name; python3 answers by default, the other two are not there.
  python?: Answer<Ran>
  pythons?: { python?: Answer<Ran>; py?: Answer<Ran> }
  gh?: Answer<Ran>
  auth?: Answer<Ran>
  ps?: Answer<Ran>
  // The variables the mod may ask for (HOME alone by default) and what stats the config directory.
  env?: Record<string, string>
  configDir?: 'directory' | 'file' | { deny: string }
  script?: 'file' | 'directory' | { deny: string }
  files?: Record<string, string | { deny: string }>
  memoryStats?: Answer<{ content: { type: 'text'; text: string }[]; isError: boolean }>
  config?: Answer<{ key: string; value: unknown; isLocked: boolean }[]>
  commands?: { name: string; source: string; plugin?: string }[]
  stateRefusal?: string
  // Leave state to the engine, which keeps the cockpit's own atoms truthfully.
  isStateReal?: boolean
  // Every process.run event the check made, as the engine delivered it (argv and init).
  runs?: { argv: string[]; timeoutMs?: number }[]
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

const OWN_COMMANDS = [
  { name: 'cortex', source: 'plugin', plugin: 'cortex-cockpit' },
  { name: 'wiki', source: 'plugin', plugin: 'cortex-wiki' },
  { name: 'fleet', source: 'plugin', plugin: 'harness-fleet' },
]

const wrap = (answer: unknown): never => ((answer as { deny?: string }).deny !== undefined ? answer : { value: answer }) as never

const NOT_THERE: Ran = { exitCode: 127, stdout: '', stderr: 'command not found' }
const AUTH: Ran = { exitCode: 0, stdout: 'github.com\n  ✓ Logged in to github.com account cdeust (keyring)\n', stderr: '' }
const PS: Ran = { exitCode: 0, stdout: '  PID ELAPSED COMMAND\n    1 01:00 /sbin/launchd\n', stderr: '' }
const CONFIG_DIR = `${HOME}/.claude`
const INSTALLED = JSON.stringify({ plugins: { 'hypermnesia-mcp@cortex-plugins': [{ version: '4.23.4' }], 'a@b': [{ version: '1' }] } })
const MARKETPLACES = JSON.stringify({
  'cortex-plugins': { source: { source: 'github', repo: 'cdeust/cortex' }, installLocation: '/m/cortex' },
  'claude-mods': { source: { source: 'directory', path: '/dev/mods' }, installLocation: '/dev/mods' },
  'other-market': { source: { source: 'github', repo: 'obra/other' }, installLocation: '/m/other' },
})
const MANIFEST = JSON.stringify({ plugins: [{ name: 'hypermnesia-mcp', version: '4.24.0' }, { name: 'hypermnesia-mcp-viz', version: '3.2.0' }] })
// What the machine holds unless a test says otherwise, by path suffix.
const FILES: Record<string, string> = {
  'plugins/installed_plugins.json': INSTALLED,
  'plugins/known_marketplaces.json': MARKETPLACES,
  '/m/cortex/.claude-plugin/marketplace.json': MANIFEST,
  '/dev/mods/.claude-plugin/marketplace.json': MANIFEST,
}

const install = (on: Parameters<TestBody>[1], world: World): void => {
  mock.clock(on, { now: 1_000_000 })
  const vars = world.env ?? { HOME }
  on('env.get', (_$, e) => ({ value: vars[String((e as { name?: string }).name ?? '')] as never }))
  on('config.list', () => wrap(world.config ?? ROWS))
  on('command.list', () => ({ value: (world.commands ?? OWN_COMMANDS).map((c) => ({ description: '', ...c })) }) as never)
  on('process.run', ($, e) => {
    const argv = (e as { argv: string[] }).argv
    world.runs?.push({ argv, timeoutMs: (e as { init?: { timeoutMs?: number } }).init?.timeoutMs })
    if (argv[0] === 'python3') return wrap(world.python ?? OK)
    if (argv[0] === 'python') return wrap(world.pythons?.python ?? NOT_THERE)
    if (argv[0] === 'py') return wrap(world.pythons?.py ?? NOT_THERE)
    if (argv[0] === 'gh' && argv[1] === 'api') return wrap(world.gh ?? RATE)
    if (argv[0] === 'gh' && argv[1] === 'auth') return wrap(world.auth ?? AUTH)
    if (argv[0] === 'ps') return wrap(world.ps ?? PS)

    return wrap({ exitCode: 0, stdout: `${argv[0]} ok`, stderr: '' })
  })
  on('fs.stat', ($, e) => {
    const kind = e.path === SCRIPT ? (world.script ?? 'file') : e.path === CONFIG_DIR || e.path === world.env?.CLAUDE_CONFIG_DIR ? (world.configDir ?? 'directory') : undefined
    if (kind === undefined) return { deny: `no stat in the test: ${e.path}` }

    return typeof kind === 'string' ? ({ value: { kind, size: 1, mtimeMs: 0 } } as never) : kind
  })
  on('fs.read', ($, e) => {
    const explicit = (world.files ?? {})[e.path]
    const file = explicit ?? Object.entries(FILES).find(([suffix]) => e.path.endsWith(suffix))?.[1] ?? '{}'

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
  expect(lineOf(text, 'python (cortex-guard)')).toBe('ok    python (cortex-guard): python3 answers: Python 3.12.1 (tried in order python3, python, py)')
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
  install(on, { python: { deny: 'sandbox-exec: python3 is not in the allow list' }, pythons: { python: { deny: 'sandbox-exec: python is not in the allow list' }, py: { deny: 'sandbox-exec: py is not in the allow list' } } })
  expect(lineOf(await check($), 'python (cortex-guard)')).toMatch(
    /^FAIL {2}python \(cortex-guard\): none of python3, python, py started: python3: could not start: .*python3 is not in the allow list; python: could not start: .*python is not in the allow list; py: could not start: .*py is not in the allow list/,
  )
})

test('a python3 that exits non-zero shows its exit code and stderr, and a failure stays a failure', async ($, on) => {
  install(on, { python: { exitCode: 127, stdout: '', stderr: 'python3: command not found' } })
  expect(lineOf(await check($), 'python (cortex-guard)')).toBe(
    'FAIL  python (cortex-guard): none of python3, python, py started: python3: exit 127: python3: command not found; python: exit 127: command not found; py: exit 127: command not found',
  )
})

// A Windows machine: python3 is the Store alias (exit 9009), python is absent, py is the launcher.
test('python3 that exits 9009 and an absent python leave py, and the line says which answered and why not the others', async ($, on) => {
  install(on, {
    python: { exitCode: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store' },
    pythons: { python: { deny: 'spawn python ENOENT' }, py: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } },
  })
  const text = await check($)
  expect(lineOf(text, 'python (cortex-guard)')).toMatch(
    /^ok {4}python \(cortex-guard\): py answers: Python 3\.12\.1 \(tried in order python3, python, py; before it python3: exit 9009: Python was not found.*; python: could not start: .*ENOENT\)/,
  )
  expect(text).toMatch(/every check passed/)
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

test('a hygiene path that is a directory, not a file, is a failure', async ($, on) => {
  install(on, { script: 'directory' })
  expect(lineOf(await check($), 'hygiene script')).toBe(`FAIL  hygiene script (cortex-guard): ${SCRIPT} is not a file (directory)`)
})

test('the gh quota call carries the 15 s timeout, so a sandbox that drops packets answers a line', async ($, on) => {
  const runs: { argv: string[]; timeoutMs?: number }[] = []
  install(on, { runs })
  await check($)
  expect(runs.find((r) => r.argv[0] === 'gh' && r.argv[1] === 'api')?.timeoutMs).toBe(15_000)
  expect(runs.find((r) => r.argv[0] === 'gh' && r.argv[1] === '--version')?.timeoutMs).toBeUndefined()
})

test('an MCP server that answers with an error shows the server text', async ($, on) => {
  install(on, { memoryStats: { content: [{ type: 'text', text: 'server not connected: plugin_hypermnesia-mcp_cortex' }], isError: true } })
  expect(lineOf(await check($), 'Cortex MCP server')).toBe('FAIL  Cortex MCP server plugin_hypermnesia-mcp_cortex: memory_stats: server not connected: plugin_hypermnesia-mcp_cortex')
})

test('an MCP call the engine refuses shows the refusal', async ($, on) => {
  install(on, { memoryStats: { deny: 'no such MCP server: plugin_hypermnesia-mcp_cortex' } })
  expect(lineOf(await check($), 'Cortex MCP server')).toMatch(/^FAIL {2}Cortex MCP server .*: memory_stats call refused: .*no such MCP server/)
})

test('the files the fleet reads: a refused read shows the refusal, a readable one what it holds', async ($, on) => {
  install(on, { files: { [`${CONFIG_DIR}/plugins/known_marketplaces.json`]: { deny: 'EPERM: operation not permitted, open' } } })
  const text = await check($)
  expect(lineOf(text, 'installed_plugins.json')).toBe(`ok    fleet file ~/.claude/plugins/installed_plugins.json: readable, 2 plugins installed (${CONFIG_DIR}/plugins/installed_plugins.json)`)
  expect(lineOf(text, 'known_marketplaces.json')).toMatch(/^FAIL {2}fleet file ~\/\.claude\/plugins\/known_marketplaces\.json: .*EPERM/)
  expect(lineOf(text, 'fleet manifests')).toMatch(/^n\/a {3}fleet manifests: not checked: known_marketplaces\.json was not read/)
})

test('a fleet record that is not the JSON the engine writes is a failure that names it', async ($, on) => {
  install(on, { files: { [`${CONFIG_DIR}/plugins/installed_plugins.json`]: '{truncated', [`${CONFIG_DIR}/plugins/known_marketplaces.json`]: '[]' } })
  const text = await check($)
  expect(lineOf(text, 'installed_plugins.json')).toMatch(/^FAIL {2}fleet file .*installed_plugins\.json: installed_plugins\.json is not valid JSON/)
  expect(lineOf(text, 'known_marketplaces.json')).toBe('FAIL  fleet file ~/.claude/plugins/known_marketplaces.json: known_marketplaces.json is not an object')
  expect(text).toMatch(/\d failed/)
})

test("the fleet's manifests are read for the owner's marketplaces and the directory ones, not for others", async ($, on) => {
  install(on, {})
  const text = await check($)
  expect(lineOf(text, 'fleet manifest cortex-plugins')).toBe('ok    fleet manifest cortex-plugins: 2 plugins offered (/m/cortex)')
  expect(lineOf(text, 'fleet manifest claude-mods')).toBe('ok    fleet manifest claude-mods: 2 plugins offered (/dev/mods)')
  expect(text).not.toContain('fleet manifest other-market')
})

test('a manifest that is refused or corrupt is a failure on its marketplace, the other still reads', async ($, on) => {
  install(on, { files: { '/m/cortex/.claude-plugin/marketplace.json': { deny: 'EACCES: permission denied' }, '/dev/mods/.claude-plugin/marketplace.json': '<html>' } })
  const text = await check($)
  expect(lineOf(text, 'fleet manifest cortex-plugins')).toMatch(/^FAIL {2}fleet manifest cortex-plugins: .*EACCES/)
  expect(lineOf(text, 'fleet manifest claude-mods')).toMatch(/^FAIL {2}fleet manifest claude-mods: marketplace\.json is not valid JSON/)
})

test('CLAUDE_CONFIG_DIR moves the fleet records, and the config directory line says where from', async ($, on) => {
  install(on, { env: { HOME, CLAUDE_CONFIG_DIR: '/work/cfg' }, files: { '/work/cfg/plugins/installed_plugins.json': INSTALLED } })
  const text = await check($)
  expect(lineOf(text, 'config directory')).toBe('ok    config directory (fleet records): /work/cfg exists (from CLAUDE_CONFIG_DIR)')
  expect(lineOf(text, 'installed_plugins.json')).toContain('(/work/cfg/plugins/installed_plugins.json)')
})

test('USERPROFILE stands for HOME, and with neither the records and the script have no place', async ($, on) => {
  install(on, { env: { USERPROFILE: HOME } })
  expect(lineOf(await check($), 'config directory')).toBe(`ok    config directory (fleet records): ${CONFIG_DIR} exists (from HOME or USERPROFILE + /.claude)`)
})

test('with no HOME, USERPROFILE or CLAUDE_CONFIG_DIR the checks that need a place fail with the reason, none says ok', async ($, on) => {
  install(on, { env: {} })
  const text = await check($)
  expect(lineOf(text, 'config directory')).toBe('FAIL  config directory (fleet records): neither HOME nor USERPROFILE is set')
  expect(lineOf(text, 'installed_plugins.json')).toBe('FAIL  fleet file ~/.claude/plugins/installed_plugins.json: ~/.claude/plugins/installed_plugins.json has no place: neither HOME nor USERPROFILE is set')
  expect(lineOf(text, 'hygiene script')).toMatch(/^FAIL {2}hygiene script \(cortex-guard\): cannot place .*neither HOME nor USERPROFILE is set/)
  expect(lineOf(text, 'fleet manifests')).toMatch(/^n\/a/)
})

test('a config directory that is a file, or one the machine refuses to stat, is a failure', async ($, on) => {
  install(on, { configDir: 'file' })
  expect(lineOf(await check($), 'config directory')).toBe(`FAIL  config directory (fleet records): ${CONFIG_DIR} is not a directory (file)`)
})

test('gh not logged in is a failure with gh\'s first line, cut at 160 characters', async ($, on) => {
  const text = `You are not logged into any GitHub hosts. To log in, run: gh auth login ${'x'.repeat(200)}`
  install(on, { auth: { exitCode: 1, stdout: '', stderr: `${text}\nsecond line` } })
  const line = lineOf(await check($), 'gh auth status')
  expect(line.startsWith('FAIL  gh auth status (harness-fleet): exit 1: You are not logged into any GitHub hosts')).toBe(true)
  expect(line.endsWith(text.slice(0, 160))).toBe(true)
  expect(line).not.toContain('second line')
})

test('gh logged in names the account line', async ($, on) => {
  install(on, {})
  expect(lineOf(await check($), 'gh auth status')).toBe('ok    gh auth status (harness-fleet): ✓ Logged in to github.com account cdeust (keyring)')
})

test('a refused gh auth call shows the refusal', async ($, on) => {
  install(on, { auth: { deny: 'sandbox-exec: gh auth is not allowed' } })
  expect(lineOf(await check($), 'gh auth status')).toMatch(/^FAIL {2}gh auth status \(harness-fleet\): could not run: .*not allowed/)
})

test('gh answering the rate limit with something that is not the document is a failure, not ok', async ($, on) => {
  install(on, { gh: { exitCode: 0, stdout: '<html>Blocked by the company proxy</html>', stderr: '' } })
  const text = await check($)
  expect(lineOf(text, 'gh api rate_limit')).toBe('FAIL  gh api rate_limit: exit 0 but the answer is not the rate_limit JSON: <html>Blocked by the company proxy</html>')
  expect(text).toMatch(/1 failed/)
})

test('a ps that answers says how many lines it read', async ($, on) => {
  install(on, {})
  expect(lineOf(await check($), 'ps (cortex-cockpit)')).toBe('ok    ps (cortex-cockpit): process table readable, 2 lines')
})

test('a ps that exits non-zero is a failure with its stderr', async ($, on) => {
  install(on, { ps: { exitCode: 1, stdout: '', stderr: 'ps: operation not permitted' } })
  expect(lineOf(await check($), 'ps (cortex-cockpit)')).toBe('FAIL  ps (cortex-cockpit): exit 1: ps: operation not permitted')
})

test('a ps the machine does not have (Windows) is a failure with the refusal', async ($, on) => {
  install(on, { ps: { deny: 'spawn ps ENOENT' } })
  expect(lineOf(await check($), 'ps (cortex-cockpit)')).toMatch(/^FAIL {2}ps \(cortex-cockpit\): could not run: .*ENOENT/)
})

test('a mod whose command is not registered reads as not loaded', async ($, on) => {
  install(on, { commands: [OWN_COMMANDS[0] as (typeof OWN_COMMANDS)[0]] })
  const text = await check($)
  expect(lineOf(text, 'mod harness-fleet')).toBe('FAIL  mod harness-fleet: not loaded: /fleet is not registered')
  expect(lineOf(text, 'mod cortex-wiki')).toBe('FAIL  mod cortex-wiki: not loaded: /wiki is not registered')
  expect(lineOf(text, 'mod cortex-cockpit')).toMatch(/^ok {4}mod cortex-cockpit: loaded/)
})

// Decoys: the name is registered, but not by the mod. Before the fix these printed `ok`.
test('a user command, an MCP prompt or another plugin named like the mod is not the mod', async ($, on) => {
  install(on, {
    commands: [
      OWN_COMMANDS[0] as (typeof OWN_COMMANDS)[0],
      { name: 'wiki', source: 'user' },
      { name: 'fleet', source: 'plugin', plugin: 'some-other-plugin' },
    ],
  })
  const text = await check($)
  expect(lineOf(text, 'mod cortex-wiki')).toBe('FAIL  mod cortex-wiki: not loaded: /wiki exists but is registered by user, not by cortex-wiki')
  expect(lineOf(text, 'mod harness-fleet')).toBe('FAIL  mod harness-fleet: not loaded: /fleet exists but is registered by plugin some-other-plugin, not by harness-fleet')
})

test('an MCP prompt named like the mod is not the mod', async ($, on) => {
  install(on, { commands: [{ name: 'cortex', source: 'plugin', plugin: 'cortex-cockpit' }, { name: 'wiki', source: 'mcp' }, { name: 'fleet', source: 'builtin' }] })
  const text = await check($)
  expect(lineOf(text, 'mod cortex-wiki')).toMatch(/^FAIL {2}.*registered by mcp, not by cortex-wiki/)
  expect(lineOf(text, 'mod harness-fleet')).toMatch(/^FAIL {2}.*registered by builtin, not by harness-fleet/)
})

test('a plugin command whose plugin the engine does not name is n/a, never ok', async ($, on) => {
  install(on, { commands: [{ name: 'cortex', source: 'plugin', plugin: 'cortex-cockpit' }, { name: 'wiki', source: 'plugin' }, { name: 'fleet', source: 'plugin' }] })
  const text = await check($)
  expect(lineOf(text, 'mod cortex-wiki')).toMatch(/^n\/a {3}mod cortex-wiki: \/wiki is a plugin's command but the engine does not say which plugin/)
  expect(lineOf(text, 'mod harness-fleet')).toMatch(/^n\/a {3}mod harness-fleet: /)
})

test('the plugin that registered the command, bare or as a name@source id, proves the mod', async ($, on) => {
  install(on, { commands: [{ name: 'wiki', source: 'plugin', plugin: 'cortex-wiki' }, { name: 'fleet', source: 'plugin', plugin: 'harness-fleet@inline' }] })
  const text = await check($)
  expect(lineOf(text, 'mod cortex-wiki')).toBe('ok    mod cortex-wiki: loaded, /wiki is registered by plugin cortex-wiki')
  expect(lineOf(text, 'mod harness-fleet')).toBe('ok    mod harness-fleet: loaded, /fleet is registered by plugin harness-fleet@inline')
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
  expect(lineOf(text, 'python (cortex-guard)')).toMatch(/^ok/)
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
