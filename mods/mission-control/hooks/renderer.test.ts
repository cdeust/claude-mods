import { expect, test } from 'claude-code/testing'

import { chooseRenderer } from './renderer'

const vars = { tmux: undefined, term: undefined, termProgram: undefined, kittyWindow: undefined }

test('pixels in kitty or Ghostty outside tmux, cells everywhere else, the option first', () => {
  expect(chooseRenderer('auto', { ...vars, term: 'xterm-kitty' }).renderer).toBe('pixels')
  expect(chooseRenderer('auto', { ...vars, termProgram: 'ghostty', term: 'xterm-ghostty' }).renderer).toBe('pixels')
  expect(chooseRenderer('auto', { ...vars, termProgram: 'ghostty', tmux: '/tmp/tmux-501/default,1,0' })).toEqual({ renderer: 'cells', reason: 'inside tmux, which passes no picture through' })
  expect(chooseRenderer('auto', { ...vars, termProgram: 'iTerm.app' }).renderer).toBe('cells')
  expect(chooseRenderer('pixels', { ...vars, tmux: 'x' }).renderer).toBe('pixels')
  expect(chooseRenderer(undefined, vars).renderer).toBe('cells')
})
