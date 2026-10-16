import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const { toolPhase } = await import(process.argv[2])
const root = join(process.env.HOME, '.claude/projects')
const files = []
for (const d of readdirSync(root)) { const p = join(root, d); try { for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) files.push(join(p, f)) } catch {} 
  try { for (const s of readdirSync(join(p))) { const sub = join(p, s, 'subagents'); try { for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(join(sub, f)) } catch {} } } catch {} }
const recent = files.map(f => [f, statSync(f).mtimeMs]).sort((a,b)=>b[1]-a[1]).slice(0, +process.argv[3] || 200).map(x=>x[0])
const count = {}; const testish = {}
for (const f of recent) for (const line of readFileSync(f,'utf8').split('\n')) {
  if (!line.includes('"tool_use"')) continue
  let j; try { j = JSON.parse(line) } catch { continue }
  for (const c of j.message?.content ?? []) if (c.type === 'tool_use') {
    const ph = toolPhase(c.name, c.input) ?? 'none'; count[ph] = (count[ph]??0)+1
    const cmd = c.name === 'Bash' ? (c.input?.command ?? '').split('\n')[0] : ''
    if (/\b(test|pytest|vitest|jest)\b/.test(cmd) && ph !== 'test') { const k = cmd.replace(/\/[^\s]*\//g,'…/').slice(0,110); testish[k] = ph }
  }
}
console.log(recent.length, 'files', count)
for (const [k,v] of Object.entries(testish).slice(0,60)) console.log(v.padEnd(15), k)
