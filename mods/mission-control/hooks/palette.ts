// The pane's colours, as 0x00RRGGBB. The pane paints its own surface, so the contrast it was
// validated against holds whatever the terminal's background is.
//
// source: the dataviz skill's reference palette (references/palette.md), the dark column of the
// eight categorical slots and its dark surface; `validate_palette.js --mode dark` passes all six
// checks on these eight (run 2026-10-14; worst adjacent CVD ΔE 8.4, normal-vision 19.3). One slot per
// phase in a fixed order, never cycled; the phase name is printed beside its colour.

import type { Phase } from './scene'

export const SURFACE = 0x1a1a19
export const INK = 0xf0efec // text primary
export const INK_2 = 0xc3c2b7 // text secondary
export const MUTED = 0x5f5e58 // own choice: grid, empty gauge cells, axis
// source: same file, status palette, critical `#d03b3b` (3.62:1 on the dark surface). A status
// colour never carries meaning alone: a failed tool call is an `x` in it, drawn in the marks row
// beside the lane, never on the bar, so it is never read as the report phase's red.
export const CRITICAL = 0xd03b3b

export const PHASE_ORDER: readonly Phase[] = ['planning', 'analysis', 'design', 'implementation', 'verification', 'test', 'review', 'report']

const SLOTS = [0x3987e5, 0xd95926, 0x199e70, 0xc98500, 0xd55181, 0x008300, 0x9085e9, 0xe66767]

export const phaseColor = (phase: Phase): number => SLOTS[PHASE_ORDER.indexOf(phase)] ?? INK_2

export const rgb = (color: number): [number, number, number] => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
