import type { Elements } from 'claude-code'

import type { CiState, FleetState, PrRow, RepoRow } from '../types'
import type { Lessons } from './fleet'

export type Ui = Elements['terminal']

export type FleetData = {
  fleet: FleetState
  lessons: Lessons
  now: number
  onRefresh: () => void
  onReview: (repo: string, pr: PrRow) => void
  onDraftIssue: () => void
}

// source: the design system's verification lexicon: a state is named, never implied by colour alone.
const CI_GLYPH: Record<CiState, string> = { success: '●', failure: '✗', pending: '◐', none: '○' }

const ageLabel = (iso: string, now: number): string => {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const h = Math.floor(ms / 3_600_000)
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

const PrLine = (ui: Ui, repo: string, pr: PrRow, now: number, onReview: FleetData['onReview']) => {
  const { Box, Button, Text } = ui
  return (
    <Box gap={1}>
      <Text color={pr.ci === 'failure' ? 'red' : pr.ci === 'success' ? 'green' : undefined}>
        {CI_GLYPH[pr.ci]} #{pr.number} {pr.isDraft ? '(draft) ' : ''}
        {pr.title.slice(0, 60)} · CI {pr.ci} · {ageLabel(pr.updatedAt, now)}
      </Text>
      <Button key={`review-${repo}-${pr.number}`} label="Review" onPress={() => onReview(repo, pr)} />
    </Box>
  )
}

const RepoBlock = (ui: Ui, r: RepoRow, now: number, onReview: FleetData['onReview']) => {
  const { Box, Text } = ui
  const title = r.repo ?? r.local ?? r.marketplace
  const plugins = r.plugins
    .map((p) => `${p.name} ${p.installed}${p.offered === null ? '' : p.isBehind ? ` → ${p.offered} offered` : ' · current'}`)
    .join(' · ')
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>
        {plugins}
        {r.marketplaceUpdatedAt === null ? '' : ` · marketplace read ${ageLabel(r.marketplaceUpdatedAt, now)}`}
      </Text>
      {r.error !== null && <Text color="red">gh: {r.error}</Text>}
      {r.repo !== null && r.readAt !== null && (
        // A failed PR read carries an error and no list: say "no reading", never "0 open PRs".
        <Text dimColor>
          {r.error !== null ? 'PRs: no reading' : `${r.prs.length} open PR${r.prs.length === 1 ? '' : 's'}`} ·{' '}
          {r.openIssues === null ? 'issues: no reading' : `${r.openIssues >= 100 ? '100+' : r.openIssues} open issues`}
        </Text>
      )}
      {r.repo !== null && r.prs.map((pr) => PrLine(ui, r.repo ?? '', pr, now, onReview))}
    </Box>
  )
}

export const FleetView = (ui: Ui, d: FleetData) => {
  const { Box, Button, Text } = ui
  const f = d.fleet
  const l = d.lessons
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Harness fleet</Text>
        <Text dimColor>
          the owner's plugins and their repositories · every action starts with a button you press; the mod itself
          only reads
        </Text>
      </Box>
      {f.inventoryError !== null && <Text color="red">inventory: {f.inventoryError}</Text>}
      {f.repos.length === 0 ? (
        <Text dimColor>no owned plugin found in installed_plugins.json</Text>
      ) : (
        f.repos.map((r) => RepoBlock(ui, r, d.now, d.onReview))
      )}
      <Box flexDirection="column">
        <Text bold dimColor>
          LESSONS
        </Text>
        <Text dimColor>
          {l.refusals} guard refusals · {l.classifierErrors} classifier errors · {l.stuckEscalations} stuck escalations ·{' '}
          {l.leanCuts} results cut
        </Text>
        <Button key="draft-issue" label="Draft issue" hotkey="i" onPress={d.onDraftIssue} />
      </Box>
      <Box gap={1}>
        <Button key="refresh" label={f.isRefreshing ? 'Refreshing…' : 'Refresh'} hotkey="r" onPress={d.onRefresh} />
        <Text dimColor>{f.readAt === null ? 'remote: not read yet' : `remote read ${Math.round((d.now - f.readAt) / 1000)} s ago`}</Text>
      </Box>
    </Box>
  )
}
