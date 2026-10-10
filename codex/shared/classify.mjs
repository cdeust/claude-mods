// Generated from mods/zetetic-genius/hooks/classify.ts; run npm run build:codex.
export const SHAPES_PATH = '~/.claude/reference/skill-routing-table.md';
export const SHAPE_SKILL_PREFIX = 'zetetic-team-subagents:';
export const parseShapes = (table)=>table.split('\n').map((line)=>line.split('|').map((cell)=>cell.trim())).filter((cells)=>cells.length >= 4 && /^[a-z][a-z-]+$/.test(cells[1] ?? '')).map((cells)=>({
            id: cells[1] ?? '',
            description: (cells[3] ?? '').replace(/\s+/g, ' ')
        }));
export const TASK_CLASSES = [
    'routine',
    'planned',
    'bugfix',
    'analysis',
    'critical'
];
const CLASS_EFFORT = {
    routine: 'low',
    planned: 'low',
    bugfix: 'medium',
    analysis: 'medium',
    critical: 'high'
};
export const effortForClass = (cls)=>CLASS_EFFORT[cls];
export const MIN_CLASSIFIABLE_CHARS = 20;
export const PROMPT_HEAD_CHARS = 4000;
export const MAX_PICKS = 2;
export const isClassifiable = (text, origin)=>origin.kind !== 'plugin' && !text.trimStart().startsWith('/') && text.trim().length >= MIN_CLASSIFIABLE_CHARS;
export const classifierSystem = (shapes, genius)=>[
        'You classify one request addressed to a coding agent. Answer with one JSON object and nothing else:',
        '{"task_class": <class>, "shapes": [<skill id>, ...], "geniuses": [{"agent": <agent>, "shape": <shape>}, ...]}',
        '',
        'task_class is exactly one of:',
        '- routine: reading, listing, searching, formatting, a one-line change, a question answered from files.',
        '- planned: implementing a plan or spec that is already written out in the request.',
        '- bugfix: a bug whose cause is clear or quickly located.',
        '- analysis: an architecture decision, a design, a research synthesis, a multi-file feature.',
        '- critical: formal correctness, concurrency, security, billing, data loss; a wrong answer is worse than a slow one.',
        '',
        `shapes and geniuses together hold at most ${MAX_PICKS} picks whose trigger the request clearly matches; both [] when none does.`,
        'Rule: if no shape below matches the problem, do not force a genius agent.',
        'A pick fits only when the request has that structure, never because the topic is adjacent.',
        'Prefer a genius shape (a precise reasoning procedure) over a skill when both would fit; never pick both for the same structure.',
        '',
        'Skills (problem-shaped methods):',
        ...shapes.map((s)=>`- ${s.id}: ${s.description}`),
        '',
        'Genius shapes (agent in parentheses, then the trigger):',
        ...genius.map((g)=>`- ${g.shape} (${g.agent}): ${g.trigger}`)
    ].join('\n');
export const classifierPrompt = (text)=>text.slice(0, PROMPT_HEAD_CHARS);
const asPick = (v, known)=>{
    const o = v;
    if (o === null || typeof o !== 'object' || typeof o.agent !== 'string' || typeof o.shape !== 'string') return undefined;
    return known.some((g)=>g.agent === o.agent && g.shape === o.shape) ? {
        agent: o.agent,
        shape: o.shape
    } : undefined;
};
export const parseClassification = (answer, shapes, genius)=>{
    const match = /\{[\s\S]*\}/.exec(answer);
    if (match === null) return undefined;
    let raw;
    try {
        raw = JSON.parse(match[0]);
    } catch  {
        return undefined;
    }
    const obj = raw;
    const cls = obj.task_class;
    if (typeof cls !== 'string' || !TASK_CLASSES.includes(cls)) return undefined;
    const knownSkills = new Set(shapes.map((s)=>s.id));
    const skills = Array.isArray(obj.shapes) ? obj.shapes : [];
    if (!skills.every((s)=>typeof s === 'string' && knownSkills.has(s))) return undefined;
    const picks = Array.isArray(obj.geniuses) ? obj.geniuses.map((g)=>asPick(g, genius)) : [];
    if (picks.some((p)=>p === undefined)) return undefined;
    const geniuses = picks.filter((p, i, all)=>all.findIndex((q)=>q.agent === p.agent) === i);
    const uniqueSkills = [
        ...new Set(skills)
    ];
    const room = Math.max(0, MAX_PICKS - geniuses.slice(0, MAX_PICKS).length);
    return {
        taskClass: cls,
        shapes: uniqueSkills.slice(0, room),
        geniuses: geniuses.slice(0, MAX_PICKS)
    };
};
export const toClassified = (c, text, startedAt, now)=>({
        turnId: null,
        text,
        taskClass: c.taskClass,
        effort: effortForClass(c.taskClass),
        shapes: c.shapes,
        geniuses: c.geniuses,
        ms: now - startedAt,
        at: now
    });
export const shapeContext = (ids)=>[
        'zetetic-genius: this request matches a reasoning shape. Before answering, invoke the Skill tool for',
        ...ids.map((id)=>`  ${SHAPE_SKILL_PREFIX}${id}`),
        'and follow its method. Say in one line which shape you applied.'
    ].join('\n');
export const BIND_HEAD_CHARS = 200;
export const sameRequest = (a, b)=>a.slice(0, BIND_HEAD_CHARS) === b.slice(0, BIND_HEAD_CHARS);
