// /cortex check: what the six mods need of the machine they run on, tested one thing at a time.
// A line is `ok`, `FAIL` or `n/a`; a refusal from the machine (a sandbox, a missing binary, an
// MCP server that is not connected) reaches the line as the first 160 characters of its own
// text, so the owner can paste it back. Every check only reads: nothing outward, nothing
// written, apart from the answer.
//
// The engine follows `$` only inside the module that spells it (and a plugin has one module), so
// this file never sees `$`: register.tsx hands it a `Machine`, the reads it may make, each one
// a call spelled in that file.

import {
  type CheckLine,
  type ConfigRow,
  GUARD_DEFAULT_SCRIPT,
  MODS,
  type Own,
  checkModels,
  checkOptions,
  cut,
  expandHome,
  firstLine,
  line,
  renderLines,
  why,
} from './checkfmt'
import { parseStats } from './model'

const GH_TIMEOUT_MS = 15_000 // source: own choice, a sandbox that drops packets must answer a line, not hang the command
const FLEET_FILES = ['~/.claude/plugins/installed_plugins.json', '~/.claude/plugins/known_marketplaces.json'] // source: harness-fleet hooks/fleet.ts

type Ran = { exitCode: number; stdout: string; stderr: string }
type McpResult = { content: readonly { type: string; text?: string }[]; isError: boolean; structuredContent?: unknown }

export type Machine = {
  home: () => Promise<string | undefined>
  config: () => Promise<readonly ConfigRow[]>
  commands: () => Promise<readonly string[]>
  // The value under one mod's declared state key; `undefined` when never written. Rejects when
  // the mod is not loaded.
  state: (mod: 'cortex-guard' | 'zetetic-genius' | 'zetetic-autopilot') => Promise<unknown>
  run: (argv: string[], timeoutMs?: number) => Promise<Ran>
  stat: (path: string) => Promise<{ kind: string }>
  read: (path: string) => Promise<string>
  memoryStats: (server: string) => Promise<McpResult>
  now: () => Promise<number>
}

async function configRows(m: Machine): Promise<{ rows: readonly ConfigRow[] } | { error: string }> {
  try {
    return { rows: await m.config() }
  } catch (error) {
    return { error: why(error) }
  }
}

// Which mods answer. cortex-guard, zetetic-genius and zetetic-autopilot are dependencies of this
// mod, and the engine leaves a mod disabled when a dependency is missing, so they are loaded
// whenever this check runs; their state is read for what it says. cortex-wiki and harness-fleet
// are loaded when the command they register is in the engine's list. A state key that was never
// written reads `undefined` for a loaded mod and for an absent one alike, so it proves nothing
// about loading.
const DEPENDENCIES = ['cortex-guard', 'zetetic-genius', 'zetetic-autopilot'] as const
type Dependency = (typeof DEPENDENCIES)[number]
const isDependency = (mod: string): mod is Dependency => (DEPENDENCIES as readonly string[]).includes(mod)
const COMMAND_OF: Readonly<Record<string, string>> = { 'cortex-wiki': 'wiki', 'harness-fleet': 'fleet' }

async function checkMods(m: Machine): Promise<{ lines: CheckLine[]; states: Record<string, unknown> }> {
  let commands: readonly string[] = []
  let commandsError = ''
  try {
    commands = await m.commands()
  } catch (error) {
    commandsError = ` (the command list was refused: ${why(error)})`
  }
  const lines: CheckLine[] = []
  const states: Record<string, unknown> = {}
  for (const mod of MODS) {
    const command = COMMAND_OF[mod]
    if (command !== undefined) {
      lines.push(
        commands.includes(command)
          ? line('ok', `mod ${mod}`, `loaded, /${command} is registered`)
          : line('FAIL', `mod ${mod}`, `not loaded: /${command} is not registered${commandsError}`),
      )
    } else if (mod === 'cortex-cockpit') {
      lines.push(line('ok', `mod ${mod}`, 'loaded, this check runs in it'))
    } else if (isDependency(mod)) {
      try {
        states[mod] = await m.state(mod)
        lines.push(line('ok', `mod ${mod}`, `loaded (a dependency of this mod), ${states[mod] === undefined ? 'state key not written yet' : 'state key readable'}`))
      } catch (error) {
        lines.push(line('FAIL', `mod ${mod}`, `state key unreadable: ${why(error)}`))
      }
    }
  }
  return { lines, states }
}

async function checkCommand(m: Machine, name: string, argv: string[]): Promise<CheckLine> {
  try {
    const ran = await m.run(argv)
    if (ran.exitCode !== 0) return line('FAIL', name, `exit ${ran.exitCode}: ${firstLine(ran.stderr) || firstLine(ran.stdout) || 'no output'}`)

    return line('ok', name, firstLine(ran.stdout) || firstLine(ran.stderr) || 'exit 0')
  } catch (error) {
    return line('FAIL', name, `${argv.join(' ')} could not start: ${why(error)}`)
  }
}

async function checkHygiene(m: Machine, rows: readonly ConfigRow[] | undefined): Promise<CheckLine> {
  const name = 'hygiene script (cortex-guard)'
  const set = rows?.find((row) => row.key === 'cortex-guard.hygiene_script')?.value
  const option = typeof set === 'string' ? set : GUARD_DEFAULT_SCRIPT
  const basis = typeof set === 'string' ? '' : ' (option not readable here, so its default location is checked)'
  if (option === '') return line('n/a', name, 'option is empty: worktree registration is disabled on purpose')
  const path = expandHome(await m.home(), option)
  if (path === undefined) return line('FAIL', name, `cannot place ${option}: HOME is not set`)
  try {
    const stat = await m.stat(path)
    return stat.kind === 'file' ? line('ok', name, `${path} exists${basis}`) : line('FAIL', name, `${path} is not a file (${stat.kind})${basis}`)
  } catch (error) {
    return line('FAIL', name, `not found at ${path}: ${why(error)}${basis}`)
  }
}

async function checkCortex(m: Machine, server: string): Promise<CheckLine> {
  const name = `Cortex MCP server ${server}`
  try {
    const parsed = parseStats(await m.memoryStats(server), await m.now())

    return 'stats' in parsed
      ? line('ok', name, `memory_stats answers, ${parsed.stats.total_memories} memories`)
      : line('FAIL', name, `memory_stats: ${cut(parsed.error)}`)
  } catch (error) {
    return line('FAIL', name, `memory_stats call refused: ${why(error)}`)
  }
}

async function checkRateLimit(m: Machine): Promise<CheckLine> {
  const name = 'gh api rate_limit'
  try {
    const ran = await m.run(['gh', 'api', 'rate_limit'], GH_TIMEOUT_MS)
    if (ran.exitCode !== 0) return line('FAIL', name, `exit ${ran.exitCode}: ${firstLine(ran.stderr) || firstLine(ran.stdout) || 'no output'}`)
    try {
      const core = (JSON.parse(ran.stdout) as { resources: { core: { remaining: number; limit: number } } }).resources.core

      return line('ok', name, `api.github.com answers, core ${core.remaining}/${core.limit} left`)
    } catch {
      return line('ok', name, `exit 0, ${firstLine(ran.stdout) || 'no JSON read'}`)
    }
  } catch (error) {
    return line('FAIL', name, `could not run: ${why(error)}`)
  }
}

async function checkFleetFiles(m: Machine): Promise<CheckLine[]> {
  const home = await m.home()
  const out: CheckLine[] = []
  for (const file of FLEET_FILES) {
    const path = expandHome(home, file)
    if (path === undefined) {
      out.push(line('FAIL', `fleet file ${file}`, 'HOME is not set'))
      continue
    }
    try {
      const text = await m.read(path)
      out.push(line('ok', `fleet file ${file}`, `readable, ${text.length} characters`))
    } catch (error) {
      out.push(line('FAIL', `fleet file ${file}`, why(error)))
    }
  }
  return out
}

export async function runChecks(m: Machine, own: Own): Promise<string> {
  const listed = await configRows(m)
  const rows = 'rows' in listed ? listed.rows : undefined
  const mods = await checkMods(m)
  const lines: CheckLine[] = [
    ...mods.lines,
    ...checkOptions(rows, 'error' in listed ? listed.error : undefined, own, mods.states),
    await checkCommand(m, 'python3 (cortex-guard)', ['python3', '--version']),
    await checkHygiene(m, rows),
    await checkCortex(m, own.server),
    await checkCommand(m, 'gh --version', ['gh', '--version']),
    await checkRateLimit(m),
    await checkCommand(m, 'git remote (harness-fleet)', ['git', 'remote']),
    ...(await checkFleetFiles(m)),
    await checkCommand(m, 'pandoc (cortex-wiki)', ['pandoc', '--version']),
    await checkCommand(m, 'xelatex (cortex-wiki)', ['xelatex', '--version']),
    checkModels(rows, mods.states),
  ]
  const failed = lines.filter((l) => l.status === 'FAIL').length

  return `/cortex check: ${failed === 0 ? 'every check passed' : `${failed} failed`}, reads only\n${renderLines(lines)}`
}
