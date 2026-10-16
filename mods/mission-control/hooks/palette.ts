// The pane's colours, as 0x00RRGGBB. The pane paints its own surface, so the contrast it was
// validated against holds whatever the terminal's background is.
//
// Every colour is an exact entry of the xterm 256-colour palette: inside tmux Claude Code draws in
// 256 colours (measured 2026-10-14: `tmux capture-pane -e` of a session with COLORTERM=truecolor
// holds only `38;5;n` codes), so a 24-bit colour is snapped to its nearest entry there and the
// validated palette would drift; an exact entry draws the same in both modes.
//
// source: the dataviz skill's reference palette (references/palette.md), its eight dark
// categorical slots snapped to the nearest 256-colour cube entries; the yellow slot's nearest
// (#d78700) fails the lightness band, so it is the next darker ochre #af8700 (136).
// `validate_palette.js --mode dark` on these eight: all checks pass, the worst adjacent CVD ΔE 6.8
// (the 6-8 band, legal only with a secondary encoding: every colour is drawn beside its phase
// name). One slot per phase in a fixed order, never cycled.

import type { ModelFamily, Phase } from './scene'

export const SURFACE = 0x1c1c1c // 234, the reference dark surface #1a1a19 snapped
export const INK = 0xeeeeee // 255, text primary; 14.7:1 on the surface
export const INK_2 = 0xbcbcbc // 250, text secondary; 9.0:1
export const MUTED = 0x8a8a8a // 245, quiet text; 5.0:1 (own choice: the reference grey 2.7:1 is too low for text)
export const GRID = 0x444444 // 238, empty gauge cells and rules, never text
// source: same file, status palette: a status colour is reserved and ships with a glyph. A failed
// tool call is an `x` and its count in it, in the marks row beside the lane, never on a bar. The
// critical step #d03b3b snaps to #d75f5f, the report slot's own entry, so it is #ff0000 (196),
// 4.3:1 on the surface and apart from every slot.
export const CRITICAL = 0xff0000

export const PHASE_ORDER: readonly Phase[] = ['planning', 'analysis', 'design', 'implementation', 'verification', 'test', 'review', 'report']

const SLOTS = [0x5f87d7, 0xd75f00, 0x00af5f, 0xaf8700, 0xd75f87, 0x008700, 0x8787d7, 0xd75f5f]

export const phaseColor = (phase: Phase): number => SLOTS[PHASE_ORDER.indexOf(phase)] ?? INK_2

export const rgb = (color: number): [number, number, number] => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]

// A second categorical dimension, the model family, drawn only in the model sections, always beside
// its printed family name and, in a step lane, at its own height (the secondary encoding). Exact
// xterm entries again. The earlier slots (sonnet #5f87d7 beside opus #8787d7) failed once a lane put
// them side by side: normal-vision ΔE 5.1, protan 1.3.
// source: `validate_palette.js --mode dark --surface #1c1c1c --pairs all` over every 3-colour set of
// the xterm cube inside the band (51 entries), best worst-pair kept: haiku/sonnet/opus pass with CVD
// ΔE 17.1, normal 34.2; fable the best fourth, all four CVD 10.1, normal 19.3. Opus is 2.4:1 on the
// surface, under 3:1: the relief the validator names is the printed family name, always present.
const FAMILY_SLOTS: Record<ModelFamily, number> = {
  haiku: 0x00af5f,
  sonnet: 0x005fff,
  opus: 0xaf005f,
  fable: 0xaf5f00,
  other: 0xbcbcbc,
  unknown: 0x444444,
}

export const familyColor = (family: ModelFamily): number => FAMILY_SLOTS[family]
