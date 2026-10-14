import type { InsightsState } from './deps'
import { advisorRow, agentRows, calibrationRow, goalRow, headline, phaseRows, proposalRows } from './insightline'
import { type Surface, tone } from './tokens'
import type { Ui } from './view'

const SHOWN_AGENTS = 5 // source: own choice, the agent types used most

export type InsightsActions = { onRunInsights: () => void; onApply: () => void; onGoal: () => void }

// What the ledger learned, and the three things the owner can do with it.
export const InsightsPanel = (ui: Ui, surface: Surface, s: InsightsState | { error: string } | null | undefined, act: InsightsActions) => {
  const { Box, Button, Text } = ui
  if (s === null || s === undefined) return <Text dimColor>insights: not loaded</Text>
  if ('error' in s) return <Text color={tone(surface, 'danger')}>insights: unreadable, {s.error}</Text>
  return (
    <Box flexDirection="column">
      <Text>{headline(s)}</Text>
      {s.phases.length === 0 ? <Text dimColor>no main turn recorded yet</Text> : phaseRows(s).map((row) => <Text dimColor>{row}</Text>)}
      <Text>{calibrationRow(s)}</Text>
      {proposalRows(s).map((row) => (
        <Text color={tone(surface, 'warn')}>{row}</Text>
      ))}
      <Text dimColor>{advisorRow(s)}</Text>
      <Text dimColor>{goalRow(s)}</Text>
      {agentRows(s, SHOWN_AGENTS).map((row) => (
        <Text dimColor>{row}</Text>
      ))}
      <Box gap={1}>
        <Button key="insights" label="Run /insights" hotkey="i" onPress={act.onRunInsights} />
        {s.proposals.length > 0 && <Button key="apply" label="Apply proposals" hotkey="a" onPress={act.onApply} />}
        <Button key="goal" label="Calibration goal" hotkey="g" onPress={act.onGoal} />
      </Box>
    </Box>
  )
}
