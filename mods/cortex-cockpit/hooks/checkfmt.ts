// The pure side of /cortex check: the line a check yields, how it is cut and printed, where `~/`
// lands. No `$` here: the engine follows `$` only inside the module that spells it (check.ts).

export const TEXT_CAP = 160 // source: the owner's instruction, a refusal is shown by its first 160 characters
export const MODS = ['cortex-guard', 'cortex-wiki', 'zetetic-genius', 'zetetic-autopilot', 'cortex-cockpit', 'harness-fleet'] as const
export const OPTION_MODS = MODS.filter((mod) => mod !== 'cortex-wiki') // cortex-wiki declares no userConfig
export const GUARD_DEFAULT_SCRIPT = '~/Developments/disk-hygiene/disk_hygiene.py' // source: cortex-guard plugin.json, hygiene_script default

export type Status = 'ok' | 'FAIL' | 'n/a'
export type CheckLine = { status: Status; name: string; detail: string }
export type ConfigRow = { key: string; value: unknown; isLocked: boolean }
export type Own = { server: string; surface: string }

export const cut = (text: string): string => text.trim().slice(0, TEXT_CAP)
export const firstLine = (text: string): string => cut(text.split('\n').find((l) => l.trim() !== '') ?? '')
export const why = (error: unknown): string => cut(error instanceof Error ? error.message : String(error))
export const line = (status: Status, name: string, detail: string): CheckLine => ({ status, name, detail })

export const renderLines = (lines: readonly CheckLine[]): string =>
  lines.map((l) => `${l.status.padEnd(4)}  ${l.name}: ${l.detail}`).join('\n')

export const expandHome = (home: string | undefined, path: string): string | undefined =>
  !path.startsWith('~/') ? path : home === undefined || home === '' ? undefined : `${home}/${path.slice(2)}`

// What a mod states about its own options in the state it publishes: the value it runs with, as
// its contract declares it (zetetic-genius `state`, zetetic-autopilot `policy`). A mod that
// publishes none (cortex-guard, harness-fleet) yields undefined.
export function statedOptions(mod: string, state: unknown): string | undefined {
  const s = state as Record<string, unknown> | null | undefined
  if (s === null || s === undefined || typeof s !== 'object') return undefined
  if (mod === 'zetetic-genius') return `mode=${JSON.stringify(s.mode)} classifier_model=${JSON.stringify(s.classifierModel)}`
  if (mod === 'zetetic-autopilot') {
    return `policy_mode=${JSON.stringify(s.mode)} quota_pressure_percent=${JSON.stringify(s.quotaPercent)} result_cap_chars=${JSON.stringify(s.resultCapChars)}`
  }
  return undefined
}

export function checkOptions(
  rows: readonly ConfigRow[] | undefined,
  error: string | undefined,
  own: Own,
  states: Readonly<Record<string, unknown>>,
): CheckLine[] {
  const out: CheckLine[] = [
    line('ok', 'option cortex-cockpit (as register() received them)', `surface=${JSON.stringify(own.surface)} cortex_server=${JSON.stringify(own.server)}`),
  ]
  if (rows === undefined) out.push(line('FAIL', 'options in /config', `$.config.list refused: ${error ?? 'no reason given'}`))
  for (const mod of OPTION_MODS) {
    if (mod === 'cortex-cockpit') continue
    const mine = (rows ?? []).filter((row) => row.key.startsWith(`${mod}.`))
    const stated = statedOptions(mod, states[mod])
    if (mine.length > 0) {
      out.push(line('ok', `option ${mod} (as /config lists them)`, mine.map((row) => `${row.key.slice(mod.length + 1)}=${cut(JSON.stringify(row.value))}${row.isLocked ? ' [locked by a trusted source]' : ''}`).join(' ')))
    } else if (stated !== undefined) {
      out.push(line('ok', `option ${mod} (as the mod states them)`, stated))
    } else {
      out.push(line('n/a', `option ${mod}`, 'not readable: the mod publishes none in its state and /config lists no row for it; its plugin.json defaults apply unless something set them'))
    }
  }
  return out
}

// A model alias is spent by a paid completion, the one way to test it; this check does not make
// one, and says so rather than fake an answer.
export function checkModels(rows: readonly ConfigRow[] | undefined, states: Readonly<Record<string, unknown>>): CheckLine {
  const set = rows?.find((row) => row.key === 'zetetic-genius.classifier_model')?.value
  const stated = (states['zetetic-genius'] as { classifierModel?: unknown } | undefined)?.classifierModel
  const classifier = typeof set === 'string' ? set : typeof stated === 'string' ? stated : 'haiku'
  return line('n/a', 'models', `not checked: an alias is only proven by a paid completion, which this check does not make. zetetic-genius classifies with "${classifier}"; zetetic-autopilot routes to fable/opus/sonnet/haiku. If a sandbox blocks one, the engine's own error appears on the turn that used it.`)
}
