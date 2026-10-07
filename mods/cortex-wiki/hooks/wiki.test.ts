import { expect, test } from 'claude-code/testing'

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
