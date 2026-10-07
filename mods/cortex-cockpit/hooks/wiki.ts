// Pure side of the wiki renderer: Markdown with ```tikz blocks becomes a pandoc job.

// source: pandoc raw attribute syntax, a ```{=latex} fence passes its body to TeX untouched
// (pandoc 3.9 manual, "Extension: raw_attribute"); proven by compiling a tikzpicture here.
const FENCE = /^```tikz[ \t]*\n([\s\S]*?)^```[ \t]*$/gm

// source: forest.sty is absent from this machine's TeX (kpsewhich forest.sty, 2026-10-07), so
// trees use TikZ's own `trees` library, part of pgf.
const PREAMBLE = [
  '\\usepackage{tikz}',
  '\\usetikzlibrary{trees,arrows.meta,positioning,shapes.geometric}',
]

export const toPandocSource = (markdown: string): string =>
  markdown.replace(
    FENCE,
    (_all, body: string) =>
      `\`\`\`{=latex}\n\\begin{tikzpicture}\n${body}\\end{tikzpicture}\n\`\`\``,
  )

export const diagramCount = (markdown: string): number => (markdown.match(FENCE) ?? []).length

export const pandocArgv = (src: string, pdf: string): string[] => [
  'pandoc',
  '-s',
  '-f',
  'markdown',
  '-t',
  'latex',
  '--pdf-engine=xelatex',
  ...PREAMBLE.flatMap((line) => ['-V', `header-includes=${line}`]),
  src,
  '-o',
  pdf,
]

export type Target = { ok: true; path: string } | { ok: false; reason: string }

// Only wiki pages: a Markdown file under a wiki/ directory, no parent escapes.
export const wikiTarget = (arg: string): Target => {
  const path = arg.trim()
  if (path === '') return { ok: false, reason: 'usage: /wiki <path to a wiki/**.md page>' }
  if (path.split('/').includes('..')) return { ok: false, reason: 'no ".." in the path' }
  if (!/(^|\/)wiki\/.+\.md$/.test(path)) return { ok: false, reason: 'not a wiki/**.md page' }
  return { ok: true, path }
}
