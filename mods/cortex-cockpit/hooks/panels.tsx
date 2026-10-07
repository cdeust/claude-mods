import type { HygieneSnapshot, StageTally } from '../types'
import { bar, tokensLeft } from './contextview'
import type { ContextHealth, GeniusState, PolicyDecision, PolicyState, Refusal } from './deps'
import { shortPath } from './hygiene'
import { ageLabel, group } from './model'
import { STAGES, shortName } from './pipeline'
import { type Surface, tone } from './tokens'
import type { Ui } from './view'

const pad2 = (n: number): string => String(n).padStart(2, '0')
export const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

const BAR_WIDTH = 30 // source: own choice, fits the narrowest docked pane the engine seats
const TOP = 5 // source: own choice, the rows a one-line summary can carry

export const ContextPanel = (ui: Ui, surface: Surface, c: ContextHealth | null, now: number) => {
  const { Box, Text } = ui
  if (c === null) return <Text dimColor>context: pending (no response measured yet)</Text>
  const b = c.band
  const color =
    b === 'hard' ? tone(surface, 'danger') : b === 'warn' ? tone(surface, 'warn') : undefined
  const left = tokensLeft(c)
  const limits = c.rateLimits.map((r) => `${r.kind} ${r.percentUsed} %`).join(' · ')
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{bar(c, BAR_WIDTH)} </Text>
        <Text color={color}>
          {c.tokens === null ? 'no reading' : `${group(c.tokens)} / ${group(c.window)}`}
          {c.percent === null ? '' : ` · ${c.percent} %`} · {b}
        </Text>
      </Box>
      <Text dimColor>
        {c.warn === null
          ? `no thresholds for ${c.model} (${c.thresholdsSource})`
          : `warn ${group(c.warn)} · hard ${group(c.hard ?? 0)} · ${
              left.toWarn === null ? '' : left.toWarn > 0 ? `${group(left.toWarn)} to warn` : 'past warn'
            }${left.toHard === null ? '' : left.toHard > 0 ? ` · ${group(left.toHard)} to hard` : ' · past hard'} · ${c.model}`}
      </Text>
      <Text dimColor>
        {limits === '' ? 'rate limits: no reading' : limits}
        {c.usd === null ? '' : ` · cost ${c.usd.toFixed(2)} USD`} · read {ageLabel(now - c.readAt)}{' '}
        ago
      </Text>
      {c.categories.length > 0 && (
        <Text dimColor>
          by category:{' '}
          {c.categories
            .filter((k) => k.tokens > 0)
            .slice(0, TOP)
            .map((k) => `${k.name} ${group(k.tokens)}`)
            .join(' · ')}
        </Text>
      )}
      {c.mcpServers.length > 0 && (
        <Text dimColor>
          MCP schemas:{' '}
          {c.mcpServers
            .slice(0, TOP)
            .map((s) => `${s.server} ${group(s.tokens)} (${s.tools} tools)`)
            .join(' · ')}
        </Text>
      )}
    </Box>
  )
}

export const PipelinePanel = (ui: Ui, surface: Surface, stages: Record<string, StageTally>) => {
  const { Box, Text } = ui
  const any = STAGES.some((s) => (stages[s]?.calls ?? 0) > 0)
  if (!any) return <Text dimColor>no pipeline tool called this session</Text>
  return (
    <Box flexDirection="column">
      {STAGES.map((name) => {
        const s = stages[name] ?? { calls: 0, blocked: 0, lastAt: null, lastTool: null }
        const idle = s.calls === 0
        const color = s.blocked > 0 ? tone(surface, 'danger') : undefined
        return (
          <Text color={color} dimColor={idle}>
            {idle ? '○' : s.blocked > 0 ? '✗' : '●'} {name.padEnd(12)}
            {idle
              ? 'not reached'
              : `${group(s.calls)} calls${s.blocked > 0 ? ` · ${group(s.blocked)} blocked` : ''} · last ${
                  s.lastTool === null ? '' : shortName(s.lastTool)
                } ${s.lastAt === null ? '' : clock(s.lastAt)}`}
          </Text>
        )
      })}
    </Box>
  )
}

export const HygienePanel = (
  ui: Ui,
  surface: Surface,
  snap: HygieneSnapshot | null,
  repo: string,
  now: number,
) => {
  const { Box, Text } = ui
  if (snap === null) return <Text dimColor>hygiene: pending</Text>
  if (snap.error !== null)
    return <Text color={tone(surface, 'danger')}>hygiene: blocked, {snap.error}</Text>
  const extra = snap.worktrees.filter((w) => !w.isMain)
  return (
    <Box flexDirection="column">
      {extra.length === 0 && <Text dimColor>no worktree beside the main checkout</Text>}
      {extra.map((w) => {
        const bad = !w.isInsideRepoRule || !w.isRegistered
        return (
          <Text color={bad ? tone(surface, 'danger') : undefined}>
            {bad ? '✗' : '●'} {shortPath(w.path, repo)}
            {w.branch === null ? '' : ` · ${w.branch.replace('refs/heads/', '')}`}
            {w.isInsideRepoRule ? '' : ' · outside <repo>/.claude/worktrees/'}
            {w.isRegistered ? ` · ${w.owner ?? 'owner unknown'}` : ' · not registered with disk_hygiene'}
            {w.pr === null ? '' : ` · ${w.pr}`}
          </Text>
        )
      })}
      {snap.testProcesses.length === 0 ? (
        <Text dimColor>no test runner running</Text>
      ) : (
        snap.testProcesses.map((p) => (
          <Text color={tone(surface, 'warn')}>
            ▶ pid {p.pid} · {p.elapsed} · {p.command}
          </Text>
        ))
      )}
      <Text dimColor>read {ageLabel(now - snap.readAt)} ago</Text>
    </Box>
  )
}

const SHOWN_REFUSALS = 6 // source: own choice, the newest refusals on screen

export const RefusalsPanel = (ui: Ui, surface: Surface, refusals: readonly Refusal[]) => {
  const { Box, Text } = ui
  if (refusals.length === 0) return <Text dimColor>no call refused this session</Text>
  return (
    <Box flexDirection="column">
      <Text>
        {group(refusals.length)} refused · wiki pages only through wiki_write · worktrees inside the
        repo
      </Text>
      {refusals.slice(-SHOWN_REFUSALS).map((r) => (
        <Text color={tone(surface, 'danger')}>
          {clock(r.at)} {r.tool.padEnd(12)} {r.rule.padEnd(22)} {r.target}
        </Text>
      ))}
    </Box>
  )
}

const SHOWN_DECISIONS = 6 // source: own choice, the newest decisions on screen

type AnyDecision = PolicyDecision | GeniusState['decisions'][number]
const decisionRow = (d: AnyDecision): string =>
  `${clock(d.at)} ${d.kind.padEnd(6)} ${d.subject.padEnd(28)} ${'from' in d ? `${d.from} → ` : '→ '}${d.to}${
    d.applied ? '' : ' · observed'
  }`

const GeniusLine = (ui: Ui, g: GeniusState | null) => {
  const { Text } = ui
  if (g === null) return <Text dimColor>genius: not loaded</Text>
  const c = g.classified
  const picks = c === null ? [] : [...c.geniuses.map((p) => `${p.agent} · ${p.shape}`), ...c.shapes]
  const last =
    c === null
      ? 'no request graded yet'
      : `last: ${c.taskClass} → effort ${c.effort} · ${picks.length === 0 ? 'no pattern' : picks.join(' · ')} · ${c.ms} ms`
  return (
    <Text dimColor>
      genius {g.mode} · classifier {g.classifierModel} · {g.skillShapesLoaded} skills · {g.geniusShapesLoaded} genius
      shapes · {last}
      {g.classifierError === null ? '' : ` · ${g.classifierError}`}
    </Text>
  )
}

export const PolicyPanel = (ui: Ui, surface: Surface, p: PolicyState | null, g: GeniusState | null) => {
  const { Box, Text } = ui
  if (p === null)
    return (
      <Box flexDirection="column">
        <Text dimColor>autopilot: not loaded</Text>
        {GeniusLine(ui, g)}
      </Box>
    )
  const pressureColor = p.pressure === 'none' ? undefined : tone(surface, 'warn')
  const decisions: AnyDecision[] = [...p.decisions, ...(g?.decisions ?? [])].sort((a, b) => a.at - b.at)
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{p.mode}</Text>
        <Text dimColor>
          {' '}
          · ladder from the graded rung, loop at medium, pressure at low · quota pressure from {p.quotaPercent} % of
          5 h · results capped at {group(p.resultCapChars)} chars
        </Text>
      </Text>
      <Text color={pressureColor}>
        pressure: {p.pressure}
        {p.charsCut > 0
          ? ` · ${group(p.charsCut)} chars kept out, about ${group(Math.round(p.charsCut / 4))} tokens (estimated)`
          : ''}
      </Text>
      {GeniusLine(ui, g)}
      {decisions.length === 0 ? (
        <Text dimColor>no decision yet</Text>
      ) : (
        decisions.slice(-SHOWN_DECISIONS).map((d) => <Text dimColor={!d.applied}>{decisionRow(d)}</Text>)
      )}
    </Box>
  )
}
