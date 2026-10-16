import { expect, test } from 'claude-code/testing'

import { ENFORCE, freshSeen, spawn, stubs } from './harness'
import { CLIP } from './spawns'

// Review of #25, m1: the wiring of two behaviours the unit tests check only as functions.

// A bare pluginConfigs key beside the marketplace install this copy runs from binds to nothing (config.ts):
// each session start says so in a toast and in a POLICY row. The test engine has no $.plugin: the name is
// plugin.json's, the root the folder holding it, which is this file's parent folder.
const NAME = 'zetetic-autopilot'
const ROOT = new URL('..', (import.meta as unknown as { url: string }).url).pathname

test('a bare key beside the running marketplace install: a toast and a named row at the start', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  const name = NAME
  seen.files['/home/t/.claude/settings.json'] = JSON.stringify({ pluginConfigs: { [name]: { options: { policy_mode: 'enforce' } } } })
  seen.files['/home/t/.claude/plugins/installed_plugins.json'] = JSON.stringify({ plugins: { [`${name}@claude-mods`]: [{ installPath: ROOT }] } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const message = `settings.json pluginConfigs["${name}"] is not read by ${name}@claude-mods: key it "${name}@claude-mods". Running on enforce from the manifest defaults`
  expect(seen.toasts).toEqual([message])
  expect(seen.decisions.filter((d) => d.kind === 'unread' && d.subject === 'options not bound').map((d) => d.to)).toEqual([message])
})

// The store's bound (spawns.ts) holds only if every record is clipped where it is written.
test('a spawn record is clipped where it is written, in the state and in the store', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const long = `plugin:${'x'.repeat(300)}`
  await $.agent.spawn(spawn(long, 'm'.repeat(300)))
  const kept = Object.values(seen.store).flat()
  expect(kept).toHaveLength(1)
  for (const r of [seen.spawns?.[0], kept[0]]) {
    expect(r?.type).toBe(long.slice(0, CLIP.type))
    expect(r?.requested).toHaveLength(CLIP.model)
    expect(r?.decided).toHaveLength(CLIP.model)
  }
})
