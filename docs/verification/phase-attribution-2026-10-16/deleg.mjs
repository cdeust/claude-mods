import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const { parseDesign } = await import("./pd.mjs")
const root = join(process.env.HOME, '.claude/projects'); const files = []
const walk = (p, d=0) => { for (const f of readdirSync(p, {withFileTypes:true})) { const q = join(p, f.name); if (f.isDirectory() && d < 3) walk(q, d+1); else if (f.name.endsWith('.jsonl')) files.push(q) } }
walk(root)
const recent = files.map(f => [f, statSync(f).mtimeMs]).filter(x => x[1] > Date.now() - 4*864e5).map(x=>x[0])
const rows = { designed: 0, none: 0 }; const byCaller = {}; const heads = {}
for (const f of recent) { const sub = f.includes('/subagents/'); for (const line of readFileSync(f,'utf8').split('\n')) {
  if (!line.includes('"Agent"')) continue; let j; try { j = JSON.parse(line) } catch { continue }
  for (const c of j.message?.content ?? []) if (c.type === 'tool_use' && c.name === 'Agent') {
    const d = parseDesign(c.input?.prompt ?? ''); const k = `${sub ? 'subagent' : 'main'} ${c.input?.subagent_type ?? '(default)'} ${d ? 'designed' : 'NONE'}`
    byCaller[k] = (byCaller[k] ?? 0) + 1
    if (!d) { const m = (c.input?.prompt ?? '').match(/^.*DESIGN.*$/m); const h = m ? 'mentions: ' + m[0].slice(0,70) : 'no DESIGN word'; heads[h] = (heads[h]??0)+1 }
  } } }
console.log(recent.length, 'files'); console.table(Object.entries(byCaller).sort((a,b)=>b[1]-a[1]).slice(0,30))
console.table(Object.entries(heads).sort((a,b)=>b[1]-a[1]).slice(0,15))
