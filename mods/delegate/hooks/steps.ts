export const ROWS_CAP = 30
export const STEPS_CAP = 200

// The first step of each subagent as the engine sent it, by agentId. A step can arrive before agent.spawn has
// given its row the agentId; it waits here until the row exists. Memory only: a lost entry shows `?`.
export type FirstStep = { model: string; effort: string }
export const firstSteps = new Map<string, FirstStep>()

// The model family of an engine model id (`claude-haiku-4-5` is `haiku`); an id of no known family is shown as is.
export const family = (id: string): string => /haiku|sonnet|opus/.exec(id)?.[0] ?? id

export const tint = (m: string): string => (m === 'haiku' ? 'green' : m === 'opus' ? 'magenta' : 'cyan')
