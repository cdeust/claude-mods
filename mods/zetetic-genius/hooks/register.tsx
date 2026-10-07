import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Classified, GeniusDecision, GeniusState } from '../types'
import {
  SHAPES_PATH,
  SHAPE_SKILL_PREFIX,
  type Shape,
  classifierPrompt,
  classifierSystem,
  isClassifiable,
  parseClassification,
  parseShapes,
  sameRequest,
  shapeContext,
  toClassified,
} from './classify'
import {
  GENIUS_DIR,
  GENIUS_INDEX,
  GENIUS_PLUGIN,
  INSTALLED_PLUGINS_PATH,
  type GeniusRow,
  geniusContext,
  installPathOf,
  parseGeniusIndex,
} from './genius'

// source: platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5: adaptive thinking is on by
// default and its tokens count toward max_tokens, so a small cap can end after the thinking block;
// the JSON answer itself is under 60 tokens, unused room costs nothing.
const CLASSIFIER_MAX_TOKENS = 1024
const CLASSIFIER_TIMEOUT_MS = 4000 // source: own choice, a prompt must not wait longer on its classifier
const DECISIONS_CAP = 50 // source: bounds $.state size; a viewer shows the last rows only

const state = atom({ plugin: 'zetetic-genius', key: 'state' } as const, {
  mode: 'observe',
  classifierModel: 'haiku',
  classified: null,
  classifierError: null,
  skillShapesLoaded: 0,
  geniusShapesLoaded: 0,
  geniusDir: null,
  decisions: [],
} as GeniusState)

// The two option lists, read at start; module state a hot reload rebuilds through session.start.
let skills: Shape[] = []
let genius: GeniusRow[] = []
let geniusDir: string | null = null

const expandHome = async ($: EngineInterface, path: string): Promise<string> =>
  path.startsWith('~/') ? `${(await $.env.get('HOME')) ?? ''}/${path.slice(2)}` : path

const fail = async ($: EngineInterface, what: string, error: unknown): Promise<void> => {
  await update($, state, (s) => ({ ...s, classifierError: `${what}: ${String(error).slice(0, 100)}` }))
}

// The skill shapes from the generated routing table; absent, the classifier grades effort alone.
async function loadSkills($: EngineInterface): Promise<void> {
  try {
    skills = parseShapes(await $.fs.read(await expandHome($, SHAPES_PATH)))
    await update($, state, (s) => ({ ...s, skillShapesLoaded: skills.length }))
  } catch (error) {
    skills = []
    await fail($, SHAPES_PATH, error)
  }
}

// The genius shapes from the installed plugin's INDEX.md, found through installed_plugins.json.
async function loadGenius($: EngineInterface): Promise<void> {
  try {
    const installed = await $.fs.read(await expandHome($, INSTALLED_PLUGINS_PATH))
    const root = installPathOf(installed, GENIUS_PLUGIN)
    if (root === undefined) throw new Error(`${GENIUS_PLUGIN} is not installed`)
    geniusDir = `${root}/${GENIUS_DIR}`
    genius = parseGeniusIndex(await $.fs.read(`${geniusDir}/${GENIUS_INDEX}`))
    await update($, state, (s) => ({ ...s, geniusDir, geniusShapesLoaded: genius.length }))
  } catch (error) {
    genius = []
    geniusDir = null
    await fail($, 'genius index', error)
  }
}

// One low-effort completion grades the request; anything but a strict answer is no decision.
async function classify($: EngineInterface, text: string): Promise<Classified | undefined> {
  const s = await read($, state)
  const started = await $.clock.now()
  const r = await $.model.complete({
    model: s.classifierModel,
    effort: 'low',
    system: [{ text: classifierSystem(skills, genius), cache: true }],
    prompt: classifierPrompt(text),
    maxTokens: CLASSIFIER_MAX_TOKENS,
    timeoutMs: CLASSIFIER_TIMEOUT_MS,
  })
  const now = await $.clock.now()
  if (!r.isAnswered) {
    await fail($, 'classifier', r.reason)
    return undefined
  }
  const c = parseClassification(r.text, skills, genius)
  if (c === undefined) {
    await fail($, 'classifier answered off-contract', r.text.slice(0, 80))
    return undefined
  }
  const classified = toClassified(c, text, started, now)
  await update($, state, (st) => ({ ...st, classified, classifierError: null }))
  return classified
}

// The context blocks a graded prompt carries: each genius pattern's procedure, then the skills.
async function contextFor($: EngineInterface, c: Classified): Promise<string[]> {
  const blocks: string[] = []
  for (const pick of c.geniuses) {
    if (geniusDir === null) break
    const path = `${geniusDir}/${pick.agent}.md`
    try {
      blocks.push(geniusContext(pick.agent, await $.fs.read(path), genius, path))
    } catch (error) {
      await fail($, path, error)
    }
  }
  if (c.shapes.length > 0) blocks.push(shapeContext(c.shapes))
  return blocks
}

const decide = (s: GeniusState, d: GeniusDecision): GeniusState => ({
  ...s,
  decisions: [...s.decisions, d].slice(-DECISIONS_CAP),
})

export const register: Register = (on, options) => {
  const mode: GeniusState['mode'] = options.mode === 'enforce' ? 'enforce' : 'observe'
  const classifierModel = String(options.classifier_model ?? 'haiku')
  // A hot reload keeps $.state from the previous load: the configured fields are set afresh.
  const configured = (s: GeniusState): GeniusState => ({ ...s, mode, classifierModel })

  on('session.start', async ($, e, next) => {
    await update($, state, configured)
    await loadSkills($)
    await loadGenius($)

    return next(e)
  })

  // /clear, /resume and /branch reset $.state and never fire session.start again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await update($, state, configured)
    await loadSkills($)
    await loadGenius($)

    return next(e)
  })

  // Observed, the prompt goes through untouched; enforced, the patterns ride beside it.
  on('prompt.submit', async ($, e, next) => {
    if (!isClassifiable(e.text, e.origin)) return next(e)
    const c = await classify($, e.text)
    if (c === undefined || (c.geniuses.length === 0 && c.shapes.length === 0)) return next(e)
    const applied = (await read($, state)).mode === 'enforce'
    for (const g of c.geniuses)
      await update($, state, (s) =>
        decide(s, { at: c.at, kind: 'genius', subject: g.shape, to: `${g.agent} pattern`, applied }),
      )
    if (c.shapes.length > 0)
      await update($, state, (s) =>
        decide(s, {
          at: c.at,
          kind: 'shape',
          subject: c.shapes.join(' + '),
          to: c.shapes.map((id) => `${SHAPE_SKILL_PREFIX}${id}`).join(', '),
          applied,
        }),
      )
    if (!applied) return next(e)
    const blocks = await contextFor($, c)
    return blocks.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...blocks] })
  })

  // prompt.submit's turnId is the turn that was running, not the one the prompt starts: the
  // grade binds to its turn here, by the prompt's opening; a turn of its own carries none.
  on('turn.start', async ($, e, next) => {
    const s = await read($, state)
    const c = s.classified
    const isOurs = c !== null && c.turnId === null && sameRequest(c.text, e.text)
    const bound = isOurs && c !== null ? { ...c, turnId: e.turnId } : c?.turnId === null ? c : null
    await update($, state, (st) => ({ ...st, classified: bound }))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, state)
    const c = s.classified
    if (e.props.hasSurvey || (c === null && s.classifierError === null)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const picks = [...(c?.geniuses.map((g) => `${g.agent} · ${g.shape}`) ?? []), ...(c?.shapes ?? [])]
    const graded =
      c === null
        ? 'no request graded'
        : `${c.taskClass} → effort ${c.effort} · ${picks.length === 0 ? 'no pattern' : picks.join(' · ')} · ${c.ms} ms`
    const trouble = s.classifierError === null ? '' : ` · ${s.classifierError}`

    return (
      <Box>
        <Text dimColor>
          genius {s.mode} · {graded}
          {trouble}
        </Text>
      </Box>
    )
  })
}
