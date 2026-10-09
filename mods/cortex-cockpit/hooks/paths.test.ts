import { expect, test } from 'claude-code/testing'

import { configDirOf, homeOf, placePath } from './paths'

const NONE = { home: undefined, userProfile: undefined, configDir: undefined }

test('the home is HOME, else USERPROFILE, and an unset or empty variable is no home', () => {
  expect(homeOf({ ...NONE, home: '/home/t', userProfile: 'C:\\Users\\t' })).toEqual({ path: '/home/t' })
  expect(homeOf({ ...NONE, userProfile: 'C:\\Users\\t' })).toEqual({ path: 'C:\\Users\\t' })
  expect(homeOf({ ...NONE, home: '', userProfile: 'C:\\Users\\t' })).toEqual({ path: 'C:\\Users\\t' })
  expect(homeOf(NONE)).toEqual({ reason: 'neither HOME nor USERPROFILE is set' })
  expect(homeOf({ ...NONE, home: '' })).toEqual({ reason: 'neither HOME nor USERPROFILE is set' })
})

test('the config directory is CLAUDE_CONFIG_DIR when set, else <home>/.claude', () => {
  expect(configDirOf({ home: '/home/t', userProfile: undefined, configDir: '/work/cfg' })).toEqual({ path: '/work/cfg' })
  expect(configDirOf({ ...NONE, home: '/home/t' })).toEqual({ path: '/home/t/.claude' })
  expect(configDirOf({ ...NONE, userProfile: 'C:\\Users\\t' })).toEqual({ path: 'C:\\Users\\t/.claude' })
  expect(configDirOf({ ...NONE, configDir: '/work/cfg' })).toEqual({ path: '/work/cfg' })
  expect(configDirOf(NONE)).toEqual({ reason: 'neither HOME nor USERPROFILE is set' })
})

test('~/.claude/... follows the config directory, any other ~/... the home, a plain path is left alone', () => {
  const vars = { home: '/home/t', userProfile: undefined, configDir: '/work/cfg/' }
  expect(placePath(vars, '~/.claude/plugins/installed_plugins.json')).toEqual({ path: '/work/cfg/plugins/installed_plugins.json' })
  expect(placePath(vars, '~/.local/state/disk-hygiene/ownership.json')).toEqual({ path: '/home/t/.local/state/disk-hygiene/ownership.json' })
  expect(placePath(vars, '~/.claudeX/y')).toEqual({ path: '/home/t/.claudeX/y' })
  expect(placePath(vars, '/abs/path')).toEqual({ path: '/abs/path' })
  expect(placePath({ ...vars, configDir: undefined }, '~/.claude/ctxguard-thresholds.json')).toEqual({ path: '/home/t/.claude/ctxguard-thresholds.json' })
  expect(placePath({ ...NONE, userProfile: 'C:\\Users\\t\\' }, '~/Developments/x.py')).toEqual({ path: 'C:\\Users\\t/Developments/x.py' })
})

test('with no home to place a ~/ path the answer is the reason, naming the path', () => {
  expect(placePath(NONE, '~/.claude/plugins/installed_plugins.json')).toEqual({
    reason: '~/.claude/plugins/installed_plugins.json has no place: neither HOME nor USERPROFILE is set',
  })
  expect(placePath({ ...NONE, configDir: '/work/cfg' }, '~/.claude/x')).toEqual({ path: '/work/cfg/x' })
  expect(placePath({ ...NONE, configDir: '/work/cfg' }, '~/Developments/x')).toEqual({ reason: '~/Developments/x has no place: neither HOME nor USERPROFILE is set' })
})
