import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { diagramCount, pandocArgv, toPandocSource, wikiTarget } from './wiki'

test('a tikz fence is wrapped in a tikzpicture and passed to TeX raw', () => {
  const out = toPandocSource('a\n\n```tikz\n\\node {x};\n```\n')
  expect(out).toContain('```{=latex}\n\\begin{tikzpicture}\n\\node {x};\n\\end{tikzpicture}')
})

test('other fences and prose are untouched', () => {
  const md = '```python\nprint(1)\n```\n\ntext $x^2$\n'
  expect(toPandocSource(md)).toBe(md)
  expect(diagramCount(md)).toBe(0)
  expect(diagramCount('```tikz\na\n```\n```tikz\nb\n```\n')).toBe(2)
})

test('pandoc is driven through xelatex with tikz and its trees library', () => {
  const argv = pandocArgv('in.md', 'out.pdf')
  expect(argv).toContain('--pdf-engine=xelatex')
  expect(argv.join(' ')).toContain('trees')
  expect(argv.slice(-3)).toEqual(['in.md', '-o', 'out.pdf'])
})

test('only wiki markdown pages are accepted', () => {
  expect(wikiTarget('wiki/adr/cortex/1060-x.md').ok).toBe(true)
  expect(wikiTarget('/r/wiki/adr/x.md').ok).toBe(true)
  expect(wikiTarget('README.md').ok).toBe(false)
  expect(wikiTarget('wiki/../etc/x.md').ok).toBe(false)
  expect(wikiTarget('  ').ok).toBe(false)
})

// The command through the engine: pandoc builds, then `open` shows the PDF. "Opened" is said only
// for an open that exited 0.
type Answer = { exitCode: number; stdout: string; stderr: string } | { deny: string }
const run = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], open: Answer): Promise<string> => {
  on('env.get', () => ({ value: '/tmp/t' }))
  on('fs.read', () => ({ value: '# page\n' }))
  on('process.run', (_$, e) => {
    const answer: Answer = (e as { argv: string[] }).argv[0] === 'open' ? open : { exitCode: 0, stdout: '', stderr: '' }

    return 'deny' in answer ? answer : { value: answer as never }
  })
  const done = await $.command.run({ command: 'wiki', args: 'wiki/adr/x.md', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)

  return done.text ?? ''
}

test('open exiting 0 is "Compiled and opened"', async ($, on) => {
  expect(await run($, on, { exitCode: 0, stdout: '', stderr: '' })).toBe('Compiled and opened /tmp/t/cortex-wiki-wiki-adr-x-md.pdf')
})

test('an open that exits non-zero is not reported as opened', async ($, on) => {
  const text = await run($, on, { exitCode: 1, stdout: '', stderr: 'The file /tmp/t/x.pdf does not exist.' })
  expect(text).toBe('Compiled to /tmp/t/cortex-wiki-wiki-adr-x-md.pdf but open failed (exit 1): The file /tmp/t/x.pdf does not exist.')
})

test('an open the machine will not start (Linux, Windows) is not reported as opened', async ($, on) => {
  const text = await run($, on, { deny: 'spawn open ENOENT' })
  expect(text).toMatch(/^Compiled to \/tmp\/t\/cortex-wiki-wiki-adr-x-md\.pdf but open could not run: .*ENOENT/)
})
