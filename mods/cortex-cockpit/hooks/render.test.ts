import { expect, mock, test } from 'claude-code/testing'

import { Cockpit } from './view'

const PANE = {
  component: 'Pane',
  requestId: 'cortex-cockpit',
  props: {
    title: 'Cortex',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// A refused tree falls back to the engine's own drawing without an error, so the
// test asserts on content only the plugin draws: mount returns undefined or
// throws when the tree does not validate.
test('the cockpit pane validates and draws on every surface that takes a Box', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('state.get', ($$, e, next) =>
    (e as { plugin?: string }).plugin === 'cortex-cockpit' ? next(e) : { value: { value: undefined, version: 0 } as never },
  )
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'cortex-cockpit', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Cortex cockpit/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no Cortex call this session/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /context: pending/ })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    await ui.unmount()
  }
})

const FULL = {
  surface: 'paper',
  now: 1_000_000,
  columns: 80,
  stats: {
    total_memories: 119304,
    episodic_count: 100000,
    semantic_count: 19304,
    active_count: 119000,
    archived_count: 304,
    stale_count: 12,
    protected_count: 7,
    avg_heat: 0.4321,
    total_entities: 5000,
    total_relationships: 9000,
    active_triggers: 2,
    last_consolidation: null,
    has_vector_search: true,
    grooming_staleness: {
      wiki: { days_since_last_run: 3.2, stale: true },
      distillation: { days_since_last_run: null, stale: false },
    },
    grooming_staleness_threshold_days: 7,
    readAt: 990_000,
  },
  statsError: null,
  ledger: [
    {
      id: '1',
      tool: 'recall',
      startedAt: 995_000,
      status: 'measured',
      ms: 250,
      count: 10,
      receipt: 42,
    },
    { id: '2', tool: 'remember', startedAt: 996_000, status: 'pending' },
    { id: '3', tool: 'forget', startedAt: 997_000, status: 'blocked', ms: 5 },
  ],
  tally: {
    turns: 4,
    input: 1000,
    output: 500,
    cacheRead: 3000,
    cacheWrite: 0,
    tools: { Bash: 12 },
  },
  context: {
    tokens: 125000,
    window: 200000,
    percent: 62,
    model: 'claude-fable-5-1',
    warn: 120000,
    hard: 160000,
    thresholdsSource: '~/.claude/ctxguard-thresholds.json',
    rateLimits: [{ kind: 'five_hour', percentUsed: 5 }],
    usd: 3.02,
    categories: [{ name: 'MCP tools', tokens: 42000 }, { name: 'Messages', tokens: 30000 }],
    mcpServers: [{ server: 'claude.ai Vercel', tools: 300, tokens: 39000 }],
    band: 'warn',
    readAt: 999_000,
  },
  stages: {
    recall: { calls: 3, blocked: 1, lastAt: 998_000, lastTool: 'mcp__plugin_hypermnesia-mcp_cortex__recall' },
  },
  refusals: [{ at: 997_000, tool: 'Edit', rule: 'wiki-write-only', target: 'wiki/adr/x.md' }],
  hygiene: {
    worktrees: [
      { path: '/r', branch: 'refs/heads/main', isMain: true, isInsideRepoRule: true, isRegistered: false, owner: null, pr: null },
      { path: '/tmp/stray', branch: null, isMain: false, isInsideRepoRule: false, isRegistered: false, owner: null, pr: null },
    ],
    testProcesses: [{ pid: 4242, elapsed: '00:12', command: 'python3 -m pytest' }],
    processesError: null,
    ownershipError: null,
    error: null,
    readAt: 996_000,
  },
  policy: {
    mode: 'observe',
    pressure: 'quota',
    quotaPercent: 80,
    resultCapChars: 16000,
    decisions: [
      { at: 995_500, kind: 'effort', subject: 'main step 2 (claude-fable-5-1)', from: 'high', to: 'medium', applied: false },
    ],
    charsCut: 0,
    errorsInRow: 0,
  },
  genius: {
    mode: 'observe',
    classifierModel: 'haiku',
    classified: {
      turnId: 't1',
      text: 'Is the claim that the cache caused the speedup even testable?',
      taskClass: 'analysis',
      effort: 'medium',
      shapes: [],
      geniuses: [{ agent: 'popper', shape: 'falsifiability-gate' }],
      ms: 412,
      at: 995_400,
    },
    classifierError: null,
    skillShapesLoaded: 15,
    geniusShapesLoaded: 451,
    geniusDir: '/p/agents/genius',
    decisions: [{ at: 995_400, kind: 'genius', subject: 'falsifiability-gate', to: 'popper pattern', applied: false }],
  },
  repo: '/r',
  onRefresh: () => {},
  onConsolidate: () => {},
  onCurateWiki: () => {},
} as const

// The plugin's own hook answers only its requestId; this one draws the populated view
// under another, so the engine validates the populated tree exactly as it would live.
test('the populated cockpit validates and shows exact numbers', async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: 'populated' }, ($$, e) =>
    Cockpit($$.ui.resolve(e) as never, FULL as never),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cortex-cockpit',
      surface,
      ...PANE,
      requestId: 'populated',
    })
    expect(await ui.find({ type: 'Text', text: /119 304 memories/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /heat 0\.4321/ })).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: /grooming wiki: 3\.2 d \(stale, threshold 7 d\)/ }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rcpt 42 measured/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /75\.0 % from cache/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /125 000 \/ 200 000 · 62 % · warn/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /35 000 to hard/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /claude\.ai Vercel 39 000 \(300 tools\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /recall\s+3 calls · 1 blocked/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /spec\s+not reached/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /outside <repo>\/\.claude\/worktrees/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pid 4242/ })).toBeDefined()
    expect(
      await ui.find({
        type: 'Text',
        text: /genius observe · classifier haiku · 15 skills · 451 genius\s+shapes · last: analysis → effort medium · popper · falsifiability-gate · 412 ms/,
      }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /genius falsifiability-gate\s+→ popper pattern · observed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /wiki-write-only/ })).toBeDefined()
    expect(await ui.find({ key: 'consolidate' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pressure: quota/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /high → medium · observed/ })).toBeDefined()
    await ui.unmount()
  }
})

const CORTEX_RECALL = 'mcp__plugin_hypermnesia-mcp_cortex__recall'
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

test('a Cortex ToolUse row validates and states its lexicon word on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  for (const surface of SURFACES) {
    for (const [state, word] of [
      [{ isRunning: true, isErrored: false }, /pending/],
      [{ isRunning: false, isErrored: false }, /measured/],
      [{ isRunning: false, isErrored: true }, /blocked/],
    ] as const) {
      const ui = await $.ui.mount({
        plugin: 'cortex-cockpit',
        surface,
        component: 'ToolUse',
        requestId: 't1',
        props: {
          tool_use_id: 't1',
          tool: CORTEX_RECALL,
          input: { query: 'design gate' },
          isInterrupted: false,
          ...state,
        },
      })
      expect(await ui.find({ type: 'Text', text: /design gate/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: word })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('a recall ToolResult validates and keeps exact counts on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const output = JSON.stringify({
    memories: Array.from({ length: 7 }, (_, i) => ({
      memory_id: String(i),
      content: `memory ${i}`,
      score: 0.9,
      heat: 0.5,
      domain: 'cortex',
    })),
    count: 7,
    receipt_id: 3390,
    intent: 'general',
    low_signal_dropped: 18,
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'cortex-cockpit',
      surface,
      component: 'ToolResult',
      requestId: 't2',
      props: { tool_use_id: 't2', tool: CORTEX_RECALL, output, isErrored: false },
    })
    expect(await ui.find({ type: 'Text', text: /7 rows/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rcpt 3390/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /18 low-signal dropped/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 more not shown here/ })).toBeDefined()
    await ui.unmount()
  }
})
