// /cortex check, the part that answers for the fleet pane and the hygiene panel: where the engine's
// records are, whether they and the marketplaces' manifests read as the JSON the fleet expects, gh's
// login, and `ps`. A line is `ok` only for what was read and parsed; what was not reached is `n/a`.
// No `$` here (see machinecheck.ts): the reads come from the `Machine`.

import { type CheckLine, type ConfigRow, firstLine, line, why } from './checkfmt'
import type { Machine } from './machinecheck'
import { configDirOf, placePath } from './paths'

const GH_TIMEOUT_MS = 15_000 // source: own choice, a sandbox that drops packets must answer a line, not hang the command
const FLEET_FILES = ['~/.claude/plugins/installed_plugins.json', '~/.claude/plugins/known_marketplaces.json'] as const // source: harness-fleet hooks/fleet.ts
const MANIFEST = '.claude-plugin/marketplace.json' // source: harness-fleet hooks/fleet.ts MARKETPLACE_MANIFEST
const DEFAULT_OWNER = 'cdeust' // source: harness-fleet plugin.json github_owner default

type Marketplace = { name: string; repo: string | null; isDirectory: boolean; installLocation: string }

const isObject = (d: unknown): d is Record<string, unknown> => d !== null && typeof d === 'object' && !Array.isArray(d)

const json = (what: string, text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${what} is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

// How many plugins installed_plugins.json records; throws the reason when it is not the object the
// engine writes (the same test the fleet pane applies).
export const countInstalled = (text: string): number => {
  const d = json('installed_plugins.json', text)
  if (!isObject(d) || !isObject(d.plugins)) throw new Error('installed_plugins.json has no "plugins" object')

  return Object.keys(d.plugins).length
}

export const readMarketplaces = (text: string): Marketplace[] => {
  const d = json('known_marketplaces.json', text)
  if (!isObject(d)) throw new Error('known_marketplaces.json is not an object')

  return Object.entries(d).flatMap(([name, m]) => {
    if (!isObject(m) || typeof m.installLocation !== 'string') return []
    const source = isObject(m.source) ? m.source : {}

    return [{ name, repo: source.source === 'github' && typeof source.repo === 'string' ? source.repo : null, isDirectory: source.source === 'directory', installLocation: m.installLocation }]
  })
}

export const countOffered = (text: string): number => {
  const d = json('marketplace.json', text)
  if (!isObject(d) || !Array.isArray(d.plugins)) throw new Error('marketplace.json has no "plugins" list')

  return d.plugins.length
}

// source: harness-fleet hooks/fleet.ts isOwned: a directory marketplace, or a GitHub one under the owner.
const isOwned = (m: Marketplace, owner: string): boolean => m.isDirectory || (m.repo !== null && m.repo.toLowerCase().startsWith(`${owner.toLowerCase()}/`))

async function checkConfigDir(m: Machine): Promise<CheckLine> {
  const name = 'config directory (fleet records)'
  const vars = await m.vars()
  const dir = configDirOf(vars)
  if ('reason' in dir) return line('FAIL', name, dir.reason)
  const from = vars.configDir === undefined || vars.configDir === '' ? 'HOME or USERPROFILE + /.claude' : 'CLAUDE_CONFIG_DIR'
  try {
    const stat = await m.stat(dir.path)

    return stat.kind === 'directory' ? line('ok', name, `${dir.path} exists (from ${from})`) : line('FAIL', name, `${dir.path} is not a directory (${stat.kind})`)
  } catch (error) {
    return line('FAIL', name, `${dir.path} (from ${from}): ${why(error)}`)
  }
}

// Reads one fleet record and says what it holds; the text it parsed is returned for the manifests.
async function checkRecord(m: Machine, file: (typeof FLEET_FILES)[number], summarise: (text: string) => string): Promise<{ line: CheckLine; text?: string }> {
  const name = `fleet file ${file}`
  const placed = placePath(await m.vars(), file)
  if ('reason' in placed) return { line: line('FAIL', name, placed.reason) }
  try {
    const text = await m.read(placed.path)

    return { line: line('ok', name, `${summarise(text)} (${placed.path})`), text }
  } catch (error) {
    return { line: line('FAIL', name, why(error)) }
  }
}

export async function checkFleetRecords(m: Machine, rows: readonly ConfigRow[] | undefined): Promise<CheckLine[]> {
  const installed = await checkRecord(m, FLEET_FILES[0], (text) => `readable, ${countInstalled(text)} plugins installed`)
  let marketplaces: Marketplace[] = []
  const known = await checkRecord(m, FLEET_FILES[1], (text) => `readable, ${(marketplaces = readMarketplaces(text)).length} marketplaces`)
  const out: CheckLine[] = [await checkConfigDir(m), installed.line, known.line]
  if (known.line.status !== 'ok') {
    return [...out, line('n/a', 'fleet manifests', 'not checked: known_marketplaces.json was not read, so the marketplaces are not known')]
  }
  const set = rows?.find((row) => row.key === 'harness-fleet.github_owner')?.value
  const owner = typeof set === 'string' && set !== '' ? set : DEFAULT_OWNER
  const owned = marketplaces.filter((one) => isOwned(one, owner))
  if (owned.length === 0) return [...out, line('n/a', 'fleet manifests', `no marketplace is the fleet's (owner ${owner}, or a directory)`)]
  for (const one of owned) {
    const name = `fleet manifest ${one.name}`
    try {
      out.push(line('ok', name, `${countOffered(await m.read(`${one.installLocation}/${MANIFEST}`))} plugins offered (${one.installLocation})`))
    } catch (error) {
      out.push(line('FAIL', name, why(error)))
    }
  }
  return out
}

export async function checkGhAuth(m: Machine): Promise<CheckLine> {
  const name = 'gh auth status (harness-fleet)'
  try {
    const ran = await m.run(['gh', 'auth', 'status'], GH_TIMEOUT_MS)
    const text = `${ran.stdout}\n${ran.stderr}`
    if (ran.exitCode !== 0) return line('FAIL', name, `exit ${ran.exitCode}: ${firstLine(ran.stderr) || firstLine(ran.stdout) || 'no output'}`)
    const said = text.split('\n').find((l) => /logged in/i.test(l))

    return line('ok', name, said === undefined ? firstLine(text) || 'exit 0' : firstLine(said))
  } catch (error) {
    return line('FAIL', name, `could not run: ${why(error)}`)
  }
}

// The hygiene panel lists test runners from `ps -eo pid,etime,command`; its exit status is read, as
// the panel reads it.
export async function checkPs(m: Machine): Promise<CheckLine> {
  const name = 'ps (cortex-cockpit)'
  try {
    const ran = await m.run(['ps', '-eo', 'pid,etime,command'])
    if (ran.exitCode !== 0) return line('FAIL', name, `exit ${ran.exitCode}: ${firstLine(ran.stderr) || firstLine(ran.stdout) || 'no output'}`)

    return line('ok', name, `process table readable, ${ran.stdout.split('\n').filter((l) => l.trim() !== '').length} lines`)
  } catch (error) {
    return line('FAIL', name, `could not run: ${why(error)}`)
  }
}
