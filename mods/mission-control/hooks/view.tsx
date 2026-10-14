// The pane's tree, from the scene: one Raster of cells, or text around pixel pictures. Both lay the
// same rows, so the two read alike.

import type { Elements } from 'claude-code'

import { LABEL, paintCells } from './cells'
import { GRID, INK, INK_2, MUTED, phaseColor } from './palette'
import { MAX_IMAGE_COLUMNS } from './bitmap'
import { curvePicture, lanesPicture } from './pixels'
import { type Scene, WINDOW_MS, rung } from './scene'

export type Ui = Elements['terminal']

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`
const RIGHT = 10
const CURVE_ROWS = 3

export const CellsView = (ui: Ui, scene: Scene, columns: number) => {
  const grid = paintCells(scene, columns)
  return <ui.Raster key="mission" columns={grid.columns} rows={grid.rows} cells={grid.encode()} />
}

const Gauges = (ui: Ui, scene: Scene) => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      <Text color={hex(INK)}>EFFORT</Text>
      {scene.gauges.map((g) => {
        const level = rung(g.calibrated ?? 'medium')
        return (
          <Text>
            <Text color={hex(INK_2)}>{g.phase.padEnd(LABEL)}</Text>
            <Text color={hex(phaseColor(g.phase))}>{'████'.repeat(level)}</Text>
            <Text color={hex(GRID)}>{'░░░░'.repeat(4 - level)}</Text>
            <Text color={hex(g.calibrated === null ? MUTED : INK_2)}>{`  ${g.calibrated ?? 'medium (default)'} / ${g.ran ?? '-'}`}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

export const PixelsView = (ui: Ui, scene: Scene, columns: number) => {
  const { Box, Text, Image } = ui
  // Image boxes are 1 to 255 columns (ImageProps): a wider pane leaves the rest of the row empty.
  const track = Math.min(MAX_IMAGE_COLUMNS, Math.max(1, columns - LABEL))
  const curveColumns = Math.max(1, track - RIGHT)
  const lanes = lanesPicture(scene, track)
  const pct = (r: number) => `${Math.round(r * 100)}%`
  return (
    <Box flexDirection="column">
      <Text color={hex(INK)}>
        MISSION CONTROL <Text color={hex(MUTED)}>{`turn ${(scene.turnId ?? '-').slice(0, 8)} - ${scene.lanes.length} lane${scene.lanes.length === 1 ? '' : 's'}, last ${WINDOW_MS / 60_000} min`}</Text>
      </Text>
      <Text> </Text>
      <Box flexDirection="row">
        <Box flexDirection="column" width={LABEL}>
          {scene.lanes.flatMap((l) => [
            <Text color={hex(l.isRunning ? INK : INK_2)}>{l.label.slice(0, LABEL - 2)}</Text>,
            <Text color={hex(MUTED)}>{l.segments.map((s) => s.phase.slice(0, 4)).filter((p, i, a) => a.indexOf(p) === i).join(' ')}</Text>,
          ])}
        </Box>
        <Image key="lanes" source={lanes.source()} columns={track} rows={Math.max(1, scene.lanes.length) * 2} alt={`${scene.lanes.length} lanes; the terminal draws no pixels here, set renderer to cells`} />
      </Box>
      <Text> </Text>
      {Gauges(ui, scene)}
      <Text> </Text>
      <Text color={hex(INK)}>FAILED CALLS PER STEP, BY PHASE (insights ledger)</Text>
      {scene.curves.length === 0 && <Text color={hex(MUTED)}>no phase has two points yet: the ledger fills as turns complete</Text>}
      {scene.curves.map((c) => (
        <Box flexDirection="row">
          <Box flexDirection="column" width={LABEL}>
            <Text color={hex(phaseColor(c.phase))}>{c.phase}</Text>
            <Text color={hex(MUTED)}>{`0-${pct(Math.max(0.1, ...c.rates))}`}</Text>
            {c.move !== null && <Text color={hex(INK_2)}>{c.move}</Text>}
          </Box>
          <Image key={`curve-${c.phase}`} source={curvePicture(c, curveColumns, CURVE_ROWS).source()} columns={curveColumns} rows={CURVE_ROWS} alt={`${c.phase} ${pct(c.rates[0]!)} to ${pct(c.rates[c.rates.length - 1]!)}`} />
          <Text color={hex(INK)}>{` ${pct(c.rates[0]!)}>${pct(c.rates[c.rates.length - 1]!)}`}</Text>
        </Box>
      ))}
    </Box>
  )
}

// Where neither cells nor pixels are drawn (desktop, VS Code, mobile): the scene in words.
export const TextView = (ui: Elements['desktop'], scene: Scene) => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      <Text>Mission control draws in the terminal. This turn:</Text>
      {scene.lanes.map((l) => (
        <Text>{`${l.label}: ${l.segments.map((s) => `${s.phase} ${s.effort ?? '-'} ${s.steps} steps${s.errors > 0 ? ` (${s.errors} failed)` : ''}`).join(', ')}`}</Text>
      ))}
    </Box>
  )
}
