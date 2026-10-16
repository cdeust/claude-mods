const DESIGN_FIELD_CAP = 80; const cap = (s) => { const t = s.trim().slice(0, 80); return t === "" ? null : t };
export const parseDesign = (prompt) => {
  if (typeof prompt !== 'string') return null
  const lines = prompt.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === 'DESIGN')
  if (start < 0) return null
  const design = { model: null, effort: null, shape: null }
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
