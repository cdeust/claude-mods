import type { Elements, RenderChildren } from 'claude-code'

import type {
  ContextHealth,
  CortexEntry,
  CortexStats,
  HygieneSnapshot,
  PolicyState,
  Refusal,
  StageTally,
  TurnTally,
} from '../types'
import { ageLabel, cacheShare, countBy, group, heatCells } from './model'
import { ContextPanel, HygienePanel, PipelinePanel, PolicyPanel, RefusalsPanel, clock } from './panels'
import { HEAT_TRACK, type Surface, tone } from './tokens'

export type Ui = Elements['terminal']

export type CockpitData = {
  surface: Surface
  now: number
  columns: number
  repo: string
  stats: CortexStats | null
  statsError: string | null
  ledger: readonly CortexEntry[]
  tally: TurnTally
  context: ContextHealth | null
  stages: Record<string, StageTally>
  refusals: readonly Refusal[]
  hygiene: HygieneSnapshot | null
  policy: PolicyState
  onRefresh: () => void
  onConsolidate: () => void
  onCurateWiki: () => void
}

const SHOWN = 8 // source: rows of the ledger kept on screen; older rows stay in state

// Micro-label: mono UPPERCASE is the one place the voice allows caps (gate G13).
const Label = (ui: Ui, text: string) => {
  const { Text } = ui
  return (
    <Text bold dimColor>
      {text}
    </Text>
  )
}

const HeatTrack = (ui: Ui, value: number) => {
  const { Text } = ui
  return (
    <Text>
      {heatCells(value, 20).map((c) =>
        c.isFilled ? <Text color={HEAT_TRACK[c.rung]}>█</Text> : <Text dimColor>·</Text>,
      )}
    </Text>
  )
}

const Memory = (ui: Ui, d: CockpitData) => {
  const { Box, Button, Text } = ui
  const s = d.stats
  if (s === null) {
    return d.statsError === null ? (
      <Text color={tone(d.surface, 'warn')}>stats: pending</Text>
    ) : (
      <Text color={tone(d.surface, 'danger')}>stats: blocked, {d.statsError}</Text>
    )
  }
  const stale = Object.entries(s.grooming_staleness)
  const anyStale = stale.some(([, g]) => g.stale)
  return (
    <Box flexDirection="column">
      <Text>
        {group(s.total_memories)} memories · episodic {group(s.episodic_count)} · semantic{' '}
        {group(s.semantic_count)} · active {group(s.active_count)} · stale {group(s.stale_count)}
      </Text>
      <Box>
        <Text>heat {s.avg_heat.toFixed(4)} </Text>
        {HeatTrack(ui, s.avg_heat)}
        <Text dimColor>
          {' '}
          · {group(s.total_entities)} entities · {group(s.total_relationships)} relationships
        </Text>
      </Box>
      <Text dimColor>
        last consolidation {s.last_consolidation ?? 'none recorded'} · vector search{' '}
        {s.has_vector_search ? 'available' : 'absent'}
      </Text>
      {stale.map(([kind, g]) => (
        <Text color={g.stale ? tone(d.surface, 'warn') : undefined} dimColor={!g.stale}>
          grooming {kind}:{' '}
          {g.days_since_last_run === null ? 'never run' : `${g.days_since_last_run.toFixed(1)} d`}
          {g.stale ? ` (stale, threshold ${s.grooming_staleness_threshold_days} d)` : ''}
        </Text>
      ))}
      {anyStale && (
        <Box gap={1}>
          <Button key="consolidate" label="Consolidate now" hotkey="c" onPress={d.onConsolidate} />
          <Button key="curate" label="Queue wiki curation" hotkey="w" onPress={d.onCurateWiki} />
        </Box>
      )}
      <Text dimColor>read {ageLabel(d.now - s.readAt)} ago</Text>
    </Box>
  )
}

const statusColor = (surface: Surface, e: CortexEntry): string | undefined =>
  e.status === 'blocked'
    ? tone(surface, 'danger')
    : e.status === 'pending'
      ? tone(surface, 'warn')
      : undefined

const Ledger = (ui: Ui, d: CockpitData) => {
  const { Box, Text } = ui
  if (d.ledger.length === 0) return <Text dimColor>no Cortex call this session</Text>
  const summary = Object.entries(countBy(d.ledger))
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => `${group(n)} ${tool}`)
    .join(' · ')
  return (
    <Box flexDirection="column">
      <Text>{summary}</Text>
      {d.ledger.slice(-SHOWN).map((e) => (
        <Text color={statusColor(d.surface, e)} dimColor={e.status === 'measured'}>
          {clock(e.startedAt)} {e.tool.padEnd(18)}{' '}
          {(e.ms === undefined ? '…' : `${group(e.ms)} ms`).padStart(9)}{' '}
          {(e.count === undefined ? 'no count' : `${group(e.count)} rows`).padStart(10)}{' '}
          {e.receipt === undefined ? '' : `rcpt ${e.receipt} `}
          {e.status}
        </Text>
      ))}
    </Box>
  )
}

const Turns = (ui: Ui, d: CockpitData) => {
  const { Box, Text } = ui
  const t = d.tally
  if (t.turns === 0) return <Text dimColor>no turn completed yet</Text>
  const share = cacheShare(t)
  const tools = Object.entries(t.tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => `${name} ${group(n)}`)
    .join(' · ')
  return (
    <Box flexDirection="column">
      <Text>
        {group(t.turns)} turns · in {group(t.input)} · out {group(t.output)} · cache read{' '}
        {group(t.cacheRead)} · cache write {group(t.cacheWrite)}
        {share === undefined ? '' : ` · ${(share * 100).toFixed(1)} % from cache`}
      </Text>
      <Text dimColor>tools: {tools || 'none'}</Text>
    </Box>
  )
}

const Section = (ui: Ui, label: string, body: RenderChildren) => {
  const { Box } = ui
  return (
    <Box flexDirection="column">
      {Label(ui, label)}
      {body}
    </Box>
  )
}

export const Cockpit = (ui: Ui, d: CockpitData) => {
  const { Box, Button, Text } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Cortex cockpit</Text>
        <Text dimColor>{'─'.repeat(Math.max(8, d.columns))}</Text>
      </Box>
      {Section(ui, 'CONTEXT', ContextPanel(ui, d.surface, d.context, d.now))}
      {Section(ui, 'MEMORY', Memory(ui, d))}
      {Section(ui, 'PIPELINE SPEC → CODE', PipelinePanel(ui, d.surface, d.stages))}
      {Section(ui, 'HYGIENE', HygienePanel(ui, d.surface, d.hygiene, d.repo, d.now))}
      {Section(ui, 'POLICY', PolicyPanel(ui, d.surface, d.policy))}
      {Section(ui, 'ENFORCED', RefusalsPanel(ui, d.surface, d.refusals))}
      {Section(ui, 'CORTEX CALLS', Ledger(ui, d))}
      {Section(ui, 'TURNS', Turns(ui, d))}
      <Button key="refresh" label="Refresh" hotkey="r" onPress={d.onRefresh} />
    </Box>
  )
}
