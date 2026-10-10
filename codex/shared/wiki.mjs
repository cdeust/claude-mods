// Generated from mods/cortex-wiki/hooks/wiki.ts; run npm run build:codex.
const FENCE = /^```tikz[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
const PREAMBLE = [
    '\\usepackage{tikz}',
    '\\usetikzlibrary{trees,arrows.meta,positioning,shapes.geometric}'
];
export const toPandocSource = (markdown)=>markdown.replace(FENCE, (_all, body)=>`\`\`\`{=latex}\n\\begin{tikzpicture}\n${body}\\end{tikzpicture}\n\`\`\``);
export const diagramCount = (markdown)=>(markdown.match(FENCE) ?? []).length;
export const pandocArgv = (src, pdf)=>[
        'pandoc',
        '-s',
        '-f',
        'markdown',
        '-t',
        'latex',
        '--pdf-engine=xelatex',
        ...PREAMBLE.flatMap((line)=>[
                '-V',
                `header-includes=${line}`
            ]),
        src,
        '-o',
        pdf
    ];
export const wikiTarget = (arg)=>{
    const path = arg.trim();
    if (path === '') return {
        ok: false,
        reason: 'usage: /wiki <path to a wiki/**.md page>'
    };
    if (path.split('/').includes('..')) return {
        ok: false,
        reason: 'no ".." in the path'
    };
    if (!/(^|\/)wiki\/.+\.md$/.test(path)) return {
        ok: false,
        reason: 'not a wiki/**.md page'
    };
    return {
        ok: true,
        path
    };
};
