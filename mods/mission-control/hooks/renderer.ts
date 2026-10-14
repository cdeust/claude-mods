// Which painter the terminal can show. Pixels need the kitty graphics protocol, which the engine
// speaks to kitty and Ghostty only; cells draw everywhere.
//
// source: claude-code types, ImageProps ("pixels ... where the terminal can (kitty, Ghostty), the
// `alt` elsewhere") and reference.md (same). Inside tmux the terminal the engine sees is tmux's own
// (measured 2026-10-14: TERM=tmux-256color, TERM_PROGRAM=tmux in a pane), neither kitty nor
// Ghostty, so cells are the default there; a tmux set up to pass kitty graphics through is the
// `renderer: pixels` option's case. The variables: tmux sets TMUX in every pane (tmux(1),
// ENVIRONMENT); kitty sets TERM=xterm-kitty and KITTY_WINDOW_ID (kitty docs); Ghostty sets
// TERM=xterm-ghostty and TERM_PROGRAM=ghostty (Ghostty docs). The option overrides when they mislead.

import type { Renderer } from '../types'

export type Choice = { renderer: Renderer; reason: string }
export type TermVars = { tmux: string | undefined; term: string | undefined; termProgram: string | undefined; kittyWindow: string | undefined }

const isSet = (v: string | undefined): v is string => v !== undefined && v !== ''

export const chooseRenderer = (setting: unknown, vars: TermVars): Choice => {
  if (setting === 'cells' || setting === 'pixels') return { renderer: setting, reason: 'set in the renderer option' }
  if (isSet(vars.tmux)) return { renderer: 'cells', reason: 'inside tmux, which is neither kitty nor Ghostty' }
  if (vars.term === 'xterm-kitty' || isSet(vars.kittyWindow)) return { renderer: 'pixels', reason: 'kitty' }
  if (vars.term === 'xterm-ghostty' || vars.termProgram === 'ghostty') return { renderer: 'pixels', reason: 'Ghostty' }
  return { renderer: 'cells', reason: `${vars.termProgram ?? vars.term ?? 'this terminal'} has no kitty graphics the engine uses` }
}
