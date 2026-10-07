// Pure half of the request classifier: what the cheap model is asked, how its answer is read,
// and what each answer means for effort and for the genius reasoning shapes.
// source: ~/.claude/reference/skill-routing-table.md, generated from the problem-shaped skills'
// `shapes:` frontmatter (zetetic-team-subagents); read at session start, never copied here.
export const SHAPES_PATH = '~/.claude/reference/skill-routing-table.md';
// source: the skills are installed under this plugin name (the Skill tool lists them so).
export const SHAPE_SKILL_PREFIX = 'zetetic-team-subagents:';
// `| shape | skill | description |` rows; the header and the separator carry no shape.
export const parseShapes = (table) => table
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4 && /^[a-z][a-z-]+$/.test(cells[1] ?? ''))
    .map((cells) => ({ id: cells[1] ?? '', description: (cells[3] ?? '').replace(/\s+/g, ' ') }));
export const TASK_CLASSES = ['routine', 'planned', 'bugfix', 'analysis', 'critical'];
const CLASS_EFFORT = {
    routine: 'low',
    planned: 'low',
    bugfix: 'medium',
    analysis: 'medium',
    critical: 'high',
};
export const effortForClass = (cls) => CLASS_EFFORT[cls];
// source: own choice, under this length the text continues the previous task ("yes", "go on")
// and carries no shape of its own.
export const MIN_CLASSIFIABLE_CHARS = 20;
// source: own choice, the opening of a request names its task; the rest is pasted material.
export const PROMPT_HEAD_CHARS = 4000;
export const MAX_SHAPES = 2; // source: /genius:route recommends 1–3 agents; two skills at most per prompt
// A slash command runs through command.run; a plugin's own submit is not the person's request.
export const isClassifiable = (text, origin) => origin.kind !== 'plugin' && !text.trimStart().startsWith('/') && text.trim().length >= MIN_CLASSIFIABLE_CHARS;
export const classifierSystem = (shapes) => [
    'You classify one request addressed to a coding agent. Answer with one JSON object and nothing else:',
    '{"task_class": <class>, "shapes": [<shape id>, ...]}',
    '',
    'task_class is exactly one of:',
    '- routine: reading, listing, searching, formatting, a one-line change, a question answered from files.',
    '- planned: implementing a plan or spec that is already written out in the request.',
    '- bugfix: a bug whose cause is clear or quickly located.',
    '- analysis: an architecture decision, a design, a research synthesis, a multi-file feature.',
    '- critical: formal correctness, concurrency, security, billing, data loss; a wrong answer is worse than a slow one.',
    '',
    `shapes lists at most ${MAX_SHAPES} reasoning shapes whose trigger the request clearly matches; [] when none does.`,
    'A shape fits only when the request has that structure, never because the topic is adjacent.',
    '',
    ...shapes.map((s) => `- ${s.id}: ${s.description}`),
].join('\n');
export const classifierPrompt = (text) => text.slice(0, PROMPT_HEAD_CHARS);
// Strict: a JSON object, fenced or bare; an unknown class or shape voids the answer.
export const parseClassification = (answer, shapes) => {
    const match = /\{[\s\S]*\}/.exec(answer);
    if (match === null)
        return undefined;
    let raw;
    try {
        raw = JSON.parse(match[0]);
    }
    catch {
        return undefined;
    }
    const obj = raw;
    const cls = obj.task_class;
    if (typeof cls !== 'string' || !TASK_CLASSES.includes(cls))
        return undefined;
    const known = new Set(shapes.map((s) => s.id));
    const list = Array.isArray(obj.shapes) ? obj.shapes : [];
    if (!list.every((s) => typeof s === 'string' && known.has(s)))
        return undefined;
    return { taskClass: cls, shapes: [...new Set(list)].slice(0, MAX_SHAPES) };
};
// What the model reads beside the prompt when a shape fits: load the skill first.
export const shapeContext = (ids) => [
    'cortex-cockpit: this request matches a reasoning shape. Before answering, invoke the Skill tool for',
    ...ids.map((id) => `  ${SHAPE_SKILL_PREFIX}${id}`),
    'and follow its method. Say in one line which shape you applied.',
].join('\n');
// source: effort-calibration.md task table, "genuinely stuck / surprising result → high".
export const STUCK_ERRORS = 3; // source: own choice, three tool errors in a row is a loop, not a slip
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
export const escalate = (effort) => {
    const i = LADDER.indexOf(effort);
    return i < 0 || effort === 'high' || i > LADDER.indexOf('high') ? effort : (LADDER[i + 1] ?? effort);
};
