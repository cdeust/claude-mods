import type { PhasesState } from './deps'
import { advisorText, loopName, shortModel, strip, trail } from './phaseline'
import { type Surface, tone } from './tokens'
import type { Ui } from './view'

const SHOWN_LOOPS = 8 // source: own choice, main and the agents of the last moments fit the pane

// One row per loop: name, model and effort, the eight phases with the current one lit, the trail.
export const PhasesPanel = (ui: Ui, surface: Surface, s: PhasesState | { error: string } | null) => {
  const { Box, Text } = ui
  if (s === null || s === undefined) return <Text dimColor>phases: autopilot not loaded</Text>
  if ('error' in s) return <Text color={tone(surface, 'danger')}>phases: unreadable, {s.error}</Text>
  if (s.loops.length === 0) return <Text dimColor>no turn yet</Text>
  return (
    <Box flexDirection="column">
      {s.loops.slice(-SHOWN_LOOPS).map((l) => (
        <Box flexDirection="column">
          <Text dimColor={l.status === 'done'}>
            {l.status === 'running' ? '● ' : '○ '}
            {loopName(l).slice(0, 44).padEnd(44)} {shortModel(l.model)} · {l.effort ?? 'default'}
            {l.type === 'main' ? ' · phase inferred from its tools' : ''}
          </Text>
          <Text>
            {'  '}
            {strip(l).map((c) =>
              c.state === 'current' ? (
                <Text bold color={l.status === 'running' ? tone(surface, 'ok') : undefined}>
                  [{c.label}]
                </Text>
              ) : (
                <Text dimColor={c.state === 'ahead'}> {c.label} </Text>
              ),
            )}
            <Text dimColor> {trail(l)}</Text>
          </Text>
        </Box>
      ))}
      <Text dimColor>{advisorText(s)}</Text>
    </Box>
  )
}
