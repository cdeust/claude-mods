// Generated from mods/zetetic-genius/hooks/genius.ts; run npm run build:codex.
export const INSTALLED_PLUGINS_PATH = '~/.claude/plugins/installed_plugins.json';
export const GENIUS_PLUGIN = 'zetetic-team-subagents@zetetic-marketplace';
export const GENIUS_DIR = 'agents/genius';
export const GENIUS_INDEX = 'INDEX.md';
export const installPathOf = (installedPluginsJson, plugin)=>{
    let parsed;
    try {
        parsed = JSON.parse(installedPluginsJson);
    } catch (error) {
        throw new Error(`installed_plugins.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`.slice(0, 160));
    }
    const path = parsed.plugins?.[plugin]?.[0]?.installPath;
    return typeof path === 'string' && path !== '' ? path : undefined;
};
const ROW = /^\|\s*\*\*([a-z0-9-]+)\*\*\s*\|\s*(.*?)\s*\|\s*\[([a-z0-9-]+)\]\([^)]*\)\s*\|\s*(.*?)\s*\|\s*$/;
export const parseGeniusIndex = (md)=>md.split('\n').map((line)=>ROW.exec(line)).filter((m)=>m !== null).map((m)=>({
            shape: m[1] ?? '',
            trigger: m[2] ?? '',
            agent: m[3] ?? '',
            keyMove: m[4] ?? ''
        }));
export const sectionOf = (file, tag)=>{
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(file);
    return m === null ? undefined : (m[1] ?? '').trim();
};
export const identityOpening = (file)=>{
    const identity = sectionOf(file, 'identity') ?? '';
    return identity.split(/\n\s*\n/).find((p)=>p.trim() !== '') ?? '';
};
export const patternEffort = (file)=>{
    const m = /^effort:\s*([a-z]+)\s*$/m.exec(file.split(/^---\s*$/m)[1] ?? '');
    return m === null ? undefined : m[1];
};
export const geniusContext = (agent, file, rows, filePath)=>{
    const matched = rows.filter((r)=>r.agent === agent);
    return [
        `zetetic-genius: apply the ${agent} reasoning pattern to this request, before anything else.`,
        '',
        identityOpening(file),
        '',
        ...matched.map((r)=>`Shape ${r.shape}: ${r.trigger}. Key move: ${r.keyMove}`),
        '',
        'Workflow:',
        sectionOf(file, 'workflow') ?? '(no workflow section)',
        '',
        'Output format:',
        sectionOf(file, 'output-format') ?? '(no output-format section)',
        '',
        `The full pattern, with its canonical moves and blind spots, is ${filePath}; read it when a step needs more than the workflow says. Say in one line which pattern you applied.`
    ].join('\n');
};
