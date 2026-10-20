// Replays the zetetic-autopilot dispatch table (mods/zetetic-autopilot/hooks/dispatch.ts, ADR-9851) over the agents the
// zetetic-insights ledger recorded, and writes the agreement per row of the table. The decision functions are the mod's
// own, imported from its sources (Node strips the types; a resolve hook adds the `.ts` the mod's imports leave out).
//
//   node scripts/replay-dispatch.mjs requests <requests.jsonl>
//       one classifier request per agent whose spawn prompt is still on disk, built by the mod's own functions
//       (CLASSIFIER_SYSTEM, classifierPrompt, DISPATCH_TABLE.classifier), with the prompt's DESIGN block taken out so
//       the class is not read off the orchestrator's own choice; run them with scripts/replay-dispatch/ (a mod that
//       sends each request through $.model.complete, as the autopilot does)
//   node scripts/replay-dispatch.mjs report <answers.jsonl> <out.md>
//       reads the answers (parseClass), and writes what 0.11.0 would decide for each agent and the agreement per row
//
// Reads ~/.claude/plugins/store/zetetic-insights_*.json (the ledger), ~/.claude/projects/**/subagents/agent-*.jsonl
// and *.meta.json (the spawn prompts), ~/.claude/projects/*/*.jsonl (the Agent calls' model and effort), and the agent
// definitions the installed plugins hold now. Writes only the file it is given.
import { registerHooks } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
})

const hooks = new URL('../mods/zetetic-autopilot/hooks/', import.meta.url)
const D = await import(new URL('dispatch.ts', hooks).href)
const { DISPATCH_TABLE } = await import(new URL('dispatch-table.ts', hooks).href)
const A = await import(new URL('agents.ts', hooks).href)
const { routeAgentModel, familyOf } = await import(new URL('route.ts', hooks).href)
const { subagentEffort } = await import(new URL('effort.ts', hooks).href)
// The turn grade's effort (0.10.0's rule for a call that names a model and no effort): zetetic-genius's own map.
const { effortForClass } = await import(new URL('../mods/zetetic-genius/hooks/classify.ts', import.meta.url).href)

const HOME = homedir()
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude')
const STORE = join(CLAUDE, 'plugins', 'store')
const PROJECTS = join(CLAUDE, 'projects')

const ls = (dir) => (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : [])
const jsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''

// The ledger: every agent record of every turn, with its turn's grade.
function ledger() {
  const out = new Map()
  for (const f of ls(STORE).filter((n) => n.startsWith('zetetic-insights_') && n.endsWith('.json'))) {
    const store = JSON.parse(readFileSync(join(STORE, f), 'utf8'))
    for (const [key, turns] of Object.entries(store)) {
      if (!(key.startsWith('turns:') || key.startsWith('legacy:')) || !Array.isArray(turns)) continue
      for (const t of turns) for (const a of t?.agents ?? []) if (a?.agentId !== undefined) out.set(a.agentId, { ...a, taskClass: t.taskClass ?? null, session: t.session, at: t.at })
    }
  }
  return [...out.values()]
}

// What the transcripts still hold of each spawn: its prompt and description (subagent transcript and meta), and the
// Agent call's input (main transcripts), by agent id.
function spawnsOnDisk() {
  const byAgent = new Map()
  const calls = new Map()
  for (const project of ls(PROJECTS)) {
    const dir = join(PROJECTS, project)
    for (const entry of ls(dir)) {
      if (entry.endsWith('.jsonl')) {
        for (const o of jsonl(join(dir, entry))) {
          for (const b of o?.message?.content ?? []) if (b?.type === 'tool_use' && b.name === 'Agent') calls.set(b.id, b.input ?? {})
          const r = o?.toolUseResult
          const use = Array.isArray(o?.message?.content) ? o.message.content.find((b) => b?.type === 'tool_result')?.tool_use_id : undefined
          if (r?.agentId !== undefined && typeof r.prompt === 'string') byAgent.set(r.agentId, { ...byAgent.get(r.agentId), prompt: r.prompt, type: r.agentType, toolUseId: use })
        }
        continue
      }
      const sub = join(dir, entry, 'subagents')
      for (const f of ls(sub).filter((n) => n.startsWith('agent-') && n.endsWith('.meta.json'))) {
        const id = f.slice('agent-'.length, -'.meta.json'.length)
        const meta = JSON.parse(readFileSync(join(sub, f), 'utf8'))
        const first = existsSync(join(sub, `agent-${id}.jsonl`)) ? jsonl(join(sub, `agent-${id}.jsonl`))[0] : undefined
        const prompt = first === undefined ? undefined : textOf(first?.message?.content)
        byAgent.set(id, { ...byAgent.get(id), ...(prompt ? { prompt } : {}), description: meta.description, type: meta.agentType, toolUseId: meta.toolUseId })
      }
    }
  }
  for (const s of byAgent.values()) s.call = s.toolUseId === undefined ? undefined : calls.get(s.toolUseId)
  return byAgent
}

// The definition a type has today (the installed plugins and ~/.claude/agents), as the mod reads it; undefined: unread.
const installed = existsSync(join(CLAUDE, 'plugins', 'installed_plugins.json')) ? readFileSync(join(CLAUDE, 'plugins', 'installed_plugins.json'), 'utf8') : undefined
function definitionOf(type) {
  if (A.INHERITING_BUILT_INS.includes(type)) return {}
  for (const path of A.definitionPaths(type, installed, CLAUDE, HOME, [])) if (existsSync(path)) return A.parseDefinition(readFileSync(path, 'utf8'))
  return undefined
}

// The prompt with its DESIGN block taken out (the block and the lines up to its first blank line, as parseDesign reads it).
function withoutDesign(prompt) {
  const lines = prompt.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === 'DESIGN')
  if (start < 0) return prompt
  let end = start + 1
  while (end < lines.length && lines[end].trim() !== '') end++
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

function records() {
  const disk = spawnsOnDisk()
  return ledger().map((a) => {
    const s = disk.get(a.agentId)
    const definition = definitionOf(a.type)
    const prompt = s?.prompt
    const facts = { fixed: false, seen: s?.toolUseId !== undefined, resumed: false, callModel: s?.call?.model, definition, design: prompt === undefined ? { refused: [] } : D.designOf(prompt) }
    return { a, s, prompt, facts }
  })
}

function requests(out) {
  const c = DISPATCH_TABLE.classifier
  const lines = records()
    .filter((r) => r.prompt !== undefined)
    .map((r) => ({
      agentId: r.a.agentId,
      request: { model: c.model, effort: c.effort, maxTokens: c.maxTokens, system: D.CLASSIFIER_SYSTEM, prompt: D.classifierPrompt(r.a.type, r.s?.description ?? '', withoutDesign(r.prompt), c.promptHeadChars) },
    }))
  writeFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  console.log(`ledger agents ${ledger().length}, with a spawn prompt on disk ${lines.length}: ${out}`)
}

const pct = (n, d) => (d === 0 ? '—' : `${n}/${d} (${Math.round((100 * n) / d)}%)`)
const fam = (m) => (m == null ? null : (familyOf(String(m)) ?? null))
const lvl = (e) => (e == null ? null : String(e).trim().toLowerCase().split(/[\s(,;]/)[0])

function report(answersPath, out) {
  const answers = new Map(jsonl(answersPath).map((x) => [x.agentId, x]))
  const all = records()
  const live = { explicit: 0, design: 0, table: 0, unclassified: 0, none: 0, noPrompt: 0 }
  const rows = new Map()
  const proxy = new Map()
  const lines = []
  for (const r of all) {
    countProxy(r, proxy)
    if (r.prompt === undefined) {
      live.noPrompt++
      continue
    }
    const l = liveOf(r, answers.get(r.a.agentId))
    live[l.path]++
    if (l.cls !== undefined) countRow(r, l.cls, rows)
    lines.push(l.line)
  }
  const md = render({ all, answers, live, rows, proxy, lines })
  writeFileSync(out, md)
  console.log(md.split('## What 0.11.0')[0])
}

// Proxy (I): the turn's grade as the class, no review; over every record whose ledger kept a DESIGN model.
function countProxy(r, proxy) {
  const designed = r.a.design ?? null
  if (designed?.model == null || r.a.taskClass == null) return
  const rung = D.rungOf(DISPATCH_TABLE, { cls: r.a.taskClass, review: false })
  const p = proxy.get(r.a.taskClass) ?? { n: 0, model: 0, effortN: 0, effort: 0 }
  p.n++
  if (fam(designed.model) === rung.model) p.model++
  if (designed.effort != null) {
    p.effortN++
    if (lvl(designed.effort) === rung.effort) p.effort++
  }
  proxy.set(r.a.taskClass, p)
}

// Counterfactual (M): the table's rung for the prompt's class, whatever decided live, against the hand-set DESIGN.
function countRow(r, cls, rows) {
  const designed = r.a.design ?? null
  const rung = D.rungOf(DISPATCH_TABLE, cls)
  const k = `${cls.cls}${cls.review ? ' review' : ''}`
  const row = rows.get(k) ?? { rung: `${rung.model}/${rung.effort}`, n: 0, designedN: 0, model: 0, effortN: 0, effort: 0, ranSame: 0 }
  row.n++
  if (fam(r.a.model) === rung.model) row.ranSame++
  if (designed?.model != null) {
    row.designedN++
    if (fam(designed.model) === rung.model) row.model++
  }
  if (designed?.effort != null) {
    row.effortN++
    if (lvl(designed.effort) === rung.effort) row.effort++
  }
  rows.set(k, row)
}

// What 0.11.0 decides live for one recovered spawn: the class counts only when the spawn is classifiable.
function liveOf(r, ans) {
  const cls = ans?.isAnswered ? D.parseClass(ans.text) : undefined
  const failed = ans === undefined ? 'not asked' : ans.isAnswered ? `off-contract: ${String(ans.text).slice(0, 40)}` : ans.reason
  const steer = D.steerOf(r.facts, DISPATCH_TABLE, D.classifiable(r.facts) ? (cls ?? { failed }) : undefined)
  const routed = routeAgentModel(r.facts.callModel, r.facts.definition, 'parent', steer)
  const call = r.facts.seen ? (r.s?.call?.effort == null ? {} : { effort: r.s.call.effort }) : undefined
  const grade = r.a.taskClass == null ? undefined : effortForClass(r.a.taskClass)
  const effort = subagentEffort({ fixed: false, call, definition: r.facts.definition, steer, grade })
  const path = ['call', 'definition'].includes(routed.reason) ? 'explicit' : ['table', 'design', 'unclassified'].includes(steer.by) ? steer.by : 'none'
  const designed = r.a.design ?? null
  const shown = cls === undefined ? `no class (${failed})` : `${cls.cls}${cls.review ? ' review' : ''}`
  const decided = `${routed.model ?? routed.stands} / ${effort.effort ?? `(${effort.reason})`}`
  return { cls, path, line: `| ${r.a.agentId} | ${r.a.type} | ${shown} | ${path} | ${decided} | ${designed?.model ?? '—'} / ${designed?.effort ?? '—'} | ${r.a.model} |` }
}

function render(tally) {
  const { all, answers, live, rows, proxy, lines } = tally
  const order = [...rows.keys()].sort()
  return [
    '# Dispatch table replay over the insights ledger',
    '',
    `Generated by \`node scripts/replay-dispatch.mjs report\` on ${new Date().toISOString().slice(0, 10)}, table version ${DISPATCH_TABLE.version}.`,
    `Ledger agents: ${all.length}. With a spawn prompt still on disk: ${all.length - live.noPrompt}. Classifier answers read: ${answers.size}.`,
    '',
    '## Counterfactual agreement per row (M: the prompt classified by the mod\'s own request, DESIGN block removed)',
    '',
    'The table\'s rung for the class the classifier gave each recovered prompt, against the DESIGN the orchestrator wrote by hand',
    '(model family, effort level) when the ledger kept one, and against the family that ran.',
    '',
    '| row | rung | agents | DESIGN model agrees | DESIGN effort agrees | ran on the rung\'s family |',
    '|---|---|---|---|---|---|',
    ...order.map((k) => {
      const r = rows.get(k)
      return `| ${k} | ${r.rung} | ${r.n} | ${pct(r.model, r.designedN)} | ${pct(r.effort, r.effortN)} | ${pct(r.ranSame, r.n)} |`
    }),
    '',
    '## Proxy agreement per class (I: the turn\'s grade stands in for the spawn\'s class, review unknown, taken as no)',
    '',
    'Every ledger record whose DESIGN names a model, prompt on disk or not.',
    '',
    '| class | rung | designed agents | DESIGN model agrees | DESIGN effort agrees |',
    '|---|---|---|---|---|',
    ...[...proxy.keys()].sort().map((k) => {
      const p = proxy.get(k)
      const rung = D.rungOf(DISPATCH_TABLE, { cls: k, review: false })
      return `| ${k} | ${rung.model}/${rung.effort} | ${p.n} | ${pct(p.model, p.n)} | ${pct(p.effort, p.effortN)} |`
    }),
    '',
    '## What 0.11.0 decides live for each recovered spawn',
    '',
    `Paths: explicit ${live.explicit}, DESIGN ${live.design}, table ${live.table}, unclassified ${live.unclassified}, none ${live.none} (no Agent call on disk: a skill's own spawn, a resume). Definitions are read as installed today; a call model or effort the main transcript no longer holds counts as absent; the grade is the ledger turn's.`,
    '',
    '| agent | type | class | path | model / effort decided | DESIGN model / effort | ran |',
    '|---|---|---|---|---|---|---|',
    ...lines,
    '',
  ].join('\n')
}

const [cmd, a1, a2] = process.argv.slice(2)
if (cmd === 'requests' && a1 !== undefined) requests(a1)
else if (cmd === 'report' && a1 !== undefined && a2 !== undefined) report(a1, a2)
else {
  console.error('usage: replay-dispatch.mjs requests <requests.jsonl> | report <answers.jsonl> <out.md>')
  process.exit(2)
}
