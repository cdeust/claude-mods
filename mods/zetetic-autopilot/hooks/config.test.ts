import { expect, test } from 'claude-code/testing'

import { runningId, unboundKeys, unboundMessage } from './config'

const ID = 'zetetic-autopilot@claude-mods'
const INSTALL = '/cache/claude-mods/zetetic-autopilot/0.7.0'
const installed = JSON.stringify({ plugins: { [ID]: [{ installPath: INSTALL }], 'other@m': [] } })
const bare = JSON.stringify({ pluginConfigs: { 'zetetic-autopilot': { options: { policy_mode: 'observe' } } } })
const full = JSON.stringify({ pluginConfigs: { [ID]: { options: { policy_mode: 'observe' } } } })
const both = JSON.stringify({ pluginConfigs: { 'zetetic-autopilot': {}, [ID]: {} } })
const PLUGIN = 'zetetic-autopilot'

test('a bare key beside the running marketplace install is unbound, and the message names the key to use', () => {
  const [u] = unboundKeys(bare, installed, PLUGIN, INSTALL)
  expect(u).toEqual({ key: PLUGIN, ids: [ID] })
  expect(unboundMessage(u as never, 'enforce')).toBe(
    'settings.json pluginConfigs["zetetic-autopilot"] is not read by zetetic-autopilot@claude-mods: key it "zetetic-autopilot@claude-mods". Running on enforce from the manifest defaults',
  )
  // The install folder is compared without a trailing slash.
  expect(unboundKeys(bare, installed, PLUGIN, `${INSTALL}/`)).toHaveLength(1)
})

test('B2: a directory-loaded (@inline) copy reads the bare key, so installed_plugins.json listing the marketplace copy is no alarm', () => {
  expect(runningId(JSON.parse(installed), PLUGIN, '/work/mods/zetetic-autopilot')).toBe('zetetic-autopilot@inline')
  expect(unboundKeys(bare, installed, PLUGIN, '/work/mods/zetetic-autopilot')).toEqual([])
})

test('B2: when the marketplace key is also set, the bare key is a leftover and not reported', () => {
  expect(unboundKeys(both, installed, PLUGIN, INSTALL)).toEqual([])
})

test('the full key, no key, or no marketplace install is not reported', () => {
  expect(unboundKeys(full, installed, PLUGIN, INSTALL)).toEqual([])
  expect(unboundKeys('{}', installed, PLUGIN, INSTALL)).toEqual([])
  expect(unboundKeys(bare, undefined, PLUGIN, INSTALL)).toEqual([])
  expect(unboundKeys(bare, JSON.stringify({ plugins: {} }), PLUGIN, INSTALL)).toEqual([])
})

test('text that is not JSON is an error, not "nothing unbound"', () => {
  expect(() => unboundKeys('{oops', installed, PLUGIN, INSTALL)).toThrow(/not valid JSON/)
})
