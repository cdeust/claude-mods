// Colour tokens of the AI Architect design system, resolved for a terminal.
// A terminal has no CSS variables, so each token is converted from its oklch
// definition to sRGB (OKLab matrices, Ottosson 2020) and written here once.
// Chrome stays greyscale: it uses the terminal's own theme keys and dimColor.
// Only the single accent and data/status tones are coloured (gate G3, G4).
// A value marked "clipped" was outside the sRGB gamut and is clamped.
const DS = 'AI Architect Design System/tokens/colors.css'

export type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'info'
export type Surface = 'ink' | 'paper'

// source: DS :L27 --accent (terracotta; selection only, never a data category)
export const ACCENT = '#cf6e39'

// source: DS :L85-88 --ok --warn --danger --info (lifted tones, dark terminal)
const LIFTED: Record<Exclude<Tone, 'accent'>, string> = {
  ok: '#65c98c',
  warn: '#e8aa4e',
  danger: '#e86154',
  info: '#57b8e3',
}

// source: DS :L57-61 --accent-deep --ok-deep --warn-deep --danger-deep --info-deep
// (warn, info and accent-deep clipped to sRGB), deep inks for a light terminal
const DEEP: Record<Tone, string> = {
  accent: '#a53e00',
  ok: '#0a693c',
  warn: '#845b00',
  danger: '#a52a24',
  info: '#006185',
}

export const tone = (surface: Surface, t: Tone): string =>
  surface === 'paper' ? DEEP[t] : t === 'accent' ? ACCENT : LIFTED[t]

// source: DS :L65-68 --heat-hot --heat-warm --heat-cool --heat-cold
// Heat track, the one gradient the gate allows (G6): cold to hot.
export const HEAT_TRACK = ['#645d51', '#9c896a', '#d99c68', '#fd9976'] as const

export const SOURCE = DS
