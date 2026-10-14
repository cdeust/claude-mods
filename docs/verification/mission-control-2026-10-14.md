# Mission control: lanes by phase, effort, learning curves, in cells or pixels (2026-10-14)

## Engine facts measured before building on them

- `Image` draws pixels only over the kitty graphics protocol, which the engine speaks to kitty and
  Ghostty (claude-code types, ImageProps; reference.md); in iTerm2 an `Image` shows its `alt`.
  Inside tmux the terminal the engine sees is tmux's own (TERM=tmux-256color, TERM_PROGRAM=tmux in
  the demo pane), so cells are the default there and `renderer: pixels` is the override. `Raster` (a grid of cells,
  24-bit colours, blocks and braille) draws everywhere. Hence two painters behind one scene.
- Inside tmux, Claude Code draws in 256 colours: `tmux capture-pane -e` of a session whose
  process has `COLORTERM=truecolor` holds only `38;5;n` codes, its own interface included. Every
  colour of the pane is therefore an exact xterm-256 entry, so it draws the same in both modes.
- The autopilot starts main's row afresh each turn, and a background agent's completion starts a
  new main turn: the first live run showed only the last turn's `report` step. The mod now keeps
  main's last 20 turns itself and draws a 10-minute window.

## Palette

The dataviz skill's reference dark categorical palette, snapped to the 256-colour cube; the yellow
slot's nearest entry fails the lightness band, so it is #af8700. `validate_palette.js --mode dark`
on `#5f87d7,#d75f00,#00af5f,#af8700,#d75f87,#008700,#8787d7,#d75f5f`: all checks pass, the worst
adjacent CVD ΔE 6.8, legal with the secondary encoding the pane has (the phase name beside every
colour). Failed calls: `x` and a count in #ff0000 (4.3:1), reserved, never a phase colour.

## Live run (worktree mods through CLAUDE_CODE_PLUGIN_DIRS, iTerm2 + tmux 3.6b, 200 columns)

A session ran a turn with three Explore agents, two deliberately failing `ls` calls and a read;
`/mission` answered `Mission control opened; drawn in cells (inside tmux, which passes no picture
through; the reason now reads "inside tmux, which is neither kitty nor Ghostty").` and docked the pane. `mission-control-2026-10-14-tmux.png` is that pane: tmux's own cell
buffer (`capture-pane -e`, glyphs and colours as stored) rendered to PNG by headless Chrome, since
neither this shell nor cortex-vision holds the macOS Screen Recording permission. Chrome's Menlo
spaces braille wider than a terminal does, so the curves read dotted there and continuous in iTerm2.
The pixel painter is covered by tests, not yet by a live kitty or Ghostty run.

## Review round 1 (REQUEST_CHANGES on 301a196), fixed

The pixel painter ignored the Image bounds (ImageProps 1 to 255 columns; ImageSource 1 to 2048
pixels a side): a pane past 270 columns made a 256-column, 2400-pixel picture, one under 26 a
0-column curve. The track is clamped to 1..255 columns, a picture's sides to 2048 pixels (the
terminal scales it to its box), and `Bitmap` refuses any side outside 1..2048. The pane is mounted
in pixels mode at 300 and 20 columns in a test. Also: fills write a row at a time through a 32-bit
view, the axis is laid once per scene, and the tmux claim cites what was measured.

## Gates

mission-control 14 tests (every cell checked against the Raster's glyph rule, `cells` length, a
readable golden of the lanes, idle cuts, mark merging, the renderer choice, the pixel pictures
under 2 MiB, the pane mounted through the engine on all four surfaces, the history wiring);
zetetic-insights 25 (the trend series); cortex-cockpit 87; `claude plugin validate` passes for
every mod; `tsc --noEmit` (typescript 5.9.3, strict) exit 0 for mission-control, zetetic-insights
and cortex-cockpit with the engine's 2.1.296 types; `check-shared.sh` identical; codex check passes.
