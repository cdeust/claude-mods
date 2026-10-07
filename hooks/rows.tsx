import type { CortexEntry } from '../types'
import { group } from './model'
import type { RecallView } from './recall'
import { HEAT_TRACK, type Surface, tone } from './tokens'
import type { Ui } from './view'

export type UseRow = {
  surface: Surface
  tool: string
  gist: string
  isRunning: boolean
  isErrored: boolean
  entry?: CortexEntry
}

const heatRung = (heat: number): number => Math.min(3, Math.max(0, Math.floor(heat * 4)))

// One ruled line per call: what was asked, and the lexicon word for where it stands.
export const UseRowView = (ui: Ui, r: UseRow) => {
  const { Box, Text } = ui
  const status = r.isErrored ? 'blocked' : r.isRunning ? 'pending' : 'measured'
  const color = r.isErrored
    ? tone(r.surface, 'danger')
    : r.isRunning
      ? tone(r.surface, 'warn')
      : undefined
  const e = r.entry
  const facts = [
    status,
    e?.ms === undefined ? undefined : `${group(e.ms)} ms`,
    e?.receipt === undefined ? undefined : `rcpt ${e.receipt}`,
  ].filter((f): f is string => f !== undefined)

  return (
    <Box>
      <Text dimColor>cortex ▸ </Text>
      <Text bold>{r.tool}</Text>
      <Text dimColor>{r.gist === '' ? '' : `  ${r.gist}`}</Text>
      <Text color={color} dimColor={color === undefined}>
        {'  '}
        {facts.join(' · ')}
      </Text>
    </Box>
  )
}

export const RecallResultView = (ui: Ui, tool: string, v: RecallView) => {
  const { Box, Text } = ui
  const head = [
    `${group(v.count)} rows`,
    v.receipt === undefined ? undefined : `rcpt ${v.receipt}`,
    v.intent === undefined ? undefined : `intent ${v.intent}`,
    v.dropped === undefined ? undefined : `${group(v.dropped)} low-signal dropped`,
  ].filter((f): f is string => f !== undefined)

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{tool}</Text>
        <Text dimColor> · {head.join(' · ')}</Text>
      </Text>
      {v.count === 0 && <Text dimColor>no memory matched</Text>}
      {v.shown.map((hit) => (
        <Text>
          {hit.heat === undefined ? (
            <Text dimColor>· </Text>
          ) : (
            <Text color={HEAT_TRACK[heatRung(hit.heat)]}>■ </Text>
          )}
          <Text dimColor>
            {hit.score === undefined ? '    ' : hit.score.toFixed(2)}{' '}
            {hit.heat === undefined ? '' : `heat ${hit.heat.toFixed(2)} `}
            {hit.domain ?? 'no domain'}{' '}
          </Text>
          {hit.content}
        </Text>
      ))}
      {v.hidden > 0 && <Text dimColor>{group(v.hidden)} more not shown here</Text>}
    </Box>
  )
}
