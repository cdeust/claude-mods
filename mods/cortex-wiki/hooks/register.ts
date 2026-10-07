import type { Register } from 'claude-code'

import { pandocArgv, toPandocSource, wikiTarget } from './wiki'

const TEX_TIMEOUT_MS = 120_000 // source: own choice, a 47 KB page with TikZ built in under a minute

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wiki',
      description: 'Compile a wiki page (Markdown with ```tikz blocks) to PDF and open it',
      argumentHint: '<wiki/**.md>',
    })

    return next(e)
  })

  on('command.run', { command: 'wiki' }, async ($, e) => {
    const target = wikiTarget(e.args)
    if (!target.ok) return { text: target.reason }
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    const out = `${tmp}/cortex-wiki-${target.path.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`
    const source = toPandocSource(await $.fs.read(target.path))
    const built = await $.process.run(pandocArgv('-', out), { stdin: source, timeoutMs: TEX_TIMEOUT_MS })
    if (built.exitCode !== 0) return { text: `TeX build failed:\n${built.stderr.slice(0, 600)}` }
    await $.process.run(['open', out])

    return { text: `Compiled and opened ${out}` }
  })
}
