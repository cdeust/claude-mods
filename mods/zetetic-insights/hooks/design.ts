// The DESIGN block an orchestrator opens a subagent's prompt with (the dispatch-contract skill): the one parser of it.
// Shared, byte-identical, by zetetic-insights (which keeps the block beside the delegation's outcome) and
// zetetic-autopilot (which applies its model and effort at the spawn): scripts/check-shared.sh keeps the copies equal.
// Pure and self-contained: a mod cannot import a file from another mod.

export type DesignBlock = { model: string | null; effort: string | null; shape: string | null }

export const DESIGN_FIELD_CAP = 80 // source: own choice, characters kept of each design field; the block states a reason, not an essay

const cap = (s: string): string | null => {
  const t = s.trim().slice(0, DESIGN_FIELD_CAP)
  return t === '' ? null : t
}

// The DESIGN block of a prompt: the lines after the first line that is exactly `DESIGN`, up to the
// first blank line. `model: X` and `effort: Y` may share a line, separated by ` · `; `genius shape:`
// takes the rest of its line. A field the block does not state is null; no block is null. Total.
export const parseDesign = (prompt: string): DesignBlock | null => {
  if (typeof prompt !== 'string') return null
  const lines = prompt.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === 'DESIGN')
  if (start < 0) return null
  const design: DesignBlock = { model: null, effort: null, shape: null }
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    if (line === '') break
    const shape = /^genius shape:(.*)$/i.exec(line)
    if (shape !== null) {
      design.shape ??= cap(shape[1] ?? '')
      continue
    }
    if (/^(task|check):/i.test(line)) continue
    for (const part of line.split(' · ')) {
      const m = /^(model|effort):(.*)$/i.exec(part.trim())
      if (m === null) continue
      const key = m[1]?.toLowerCase() === 'model' ? 'model' : 'effort'
      design[key] ??= cap(m[2] ?? '')
    }
  }
  return design
}
