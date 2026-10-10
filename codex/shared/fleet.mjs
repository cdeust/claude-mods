// Generated from mods/harness-fleet/hooks/fleet.ts; run npm run build:codex.
export const INSTALLED_PLUGINS_PATH = '~/.claude/plugins/installed_plugins.json';
export const KNOWN_MARKETPLACES_PATH = '~/.claude/plugins/known_marketplaces.json';
export const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';
const parseJson = (what, text)=>{
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${what} is not valid JSON (${error instanceof Error ? error.message : String(error)})`.slice(0, 160));
    }
};
const isObject = (d)=>d !== null && typeof d === 'object' && !Array.isArray(d);
export const parseInstalled = (json)=>{
    const what = 'installed_plugins.json';
    const d = parseJson(what, json);
    if (!isObject(d) || !isObject(d.plugins)) throw new Error(`${what} has no "plugins" object`);
    return Object.entries(d.plugins).flatMap(([key, entries])=>{
        if (!Array.isArray(entries)) throw new Error(`${what}: "${key}" is not a list`);
        const at = key.lastIndexOf('@');
        const version = entries[0]?.version;
        if (at <= 0 || typeof version !== 'string') return [];
        return [
            {
                name: key.slice(0, at),
                marketplace: key.slice(at + 1),
                version
            }
        ];
    });
};
export const parseMarketplaces = (json)=>{
    const what = 'known_marketplaces.json';
    const d = parseJson(what, json);
    if (!isObject(d)) throw new Error(`${what} is not an object`);
    return Object.entries(d).flatMap(([name, m])=>{
        if (!isObject(m) || typeof m.installLocation !== 'string') return [];
        const src = m.source ?? {};
        return [
            {
                name,
                repo: src.source === 'github' && typeof src.repo === 'string' ? src.repo : null,
                path: src.source === 'directory' && typeof src.path === 'string' ? src.path : null,
                installLocation: m.installLocation,
                lastUpdated: typeof m.lastUpdated === 'string' ? m.lastUpdated : null
            }
        ];
    });
};
export const parseOffered = (manifestJson)=>{
    const what = 'marketplace.json';
    const d = parseJson(what, manifestJson);
    if (!isObject(d) || !Array.isArray(d.plugins)) throw new Error(`${what} has no "plugins" list`);
    const out = {};
    for (const p of d.plugins)if (typeof p?.name === 'string' && typeof p.version === 'string') out[p.name] = p.version;
    return out;
};
export const isBehind = (installed, offered)=>{
    if (offered === null || installed === offered) return false;
    const a = installed.split('.').map(Number);
    const b = offered.split('.').map(Number);
    if (a.some(Number.isNaN) || b.some(Number.isNaN)) return installed < offered;
    for(let i = 0; i < Math.max(a.length, b.length); i++){
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) return x < y;
    }
    return false;
};
export const isOwned = (m, owner)=>m.path !== null || m.repo !== null && m.repo.toLowerCase().startsWith(`${owner.toLowerCase()}/`);
export const fleetRows = (installed, marketplaces, offered, owner)=>marketplaces.filter((m)=>isOwned(m, owner)).map((m)=>{
        const read = offered[m.name];
        const versions = read !== undefined && 'offered' in read ? read.offered : {};
        const plugins = installed.filter((p)=>p.marketplace === m.name).map((p)=>{
            const off = versions[p.name] ?? null;
            return {
                name: p.name,
                installed: p.version,
                offered: off,
                isBehind: isBehind(p.version, off)
            };
        });
        return {
            repo: m.repo,
            local: m.path,
            marketplace: m.name,
            marketplaceUpdatedAt: m.lastUpdated,
            manifestError: read !== undefined && 'error' in read ? read.error : null,
            plugins,
            prs: [],
            prTotal: null,
            prTotalError: null,
            issues: null,
            issuesError: null,
            error: null,
            readAt: null
        };
    }).filter((r)=>r.plugins.length > 0);
export const repoOfRemote = (url)=>{
    const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(url.trim());
    return m === null ? null : m[1] ?? null;
};
const RED = new Set([
    'FAILURE',
    'ERROR',
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE'
]);
const IGNORED = new Set([
    'SKIPPED',
    'NEUTRAL'
]);
export const ciOf = (rollup)=>{
    if (rollup.length === 0) return 'none';
    let hasGreen = false;
    let isPending = false;
    for (const r of rollup){
        const verdict = r.__typename === 'StatusContext' ? r.state : r.conclusion;
        if (r.__typename !== 'StatusContext' && r.status !== undefined && r.status !== 'COMPLETED') {
            isPending = true;
            continue;
        }
        if (verdict === undefined || verdict === null || verdict === 'PENDING' || verdict === 'EXPECTED') {
            isPending = true;
            continue;
        }
        if (RED.has(verdict)) return 'failure';
        if (verdict === 'SUCCESS') hasGreen = true;
        else if (!IGNORED.has(verdict)) isPending = true;
    }
    if (isPending) return 'pending';
    return hasGreen ? 'success' : 'none';
};
export const parsePrList = (json)=>{
    const d = parseJson('gh pr list output', json);
    if (!Array.isArray(d)) throw new Error('gh pr list output is not a list');
    return d.flatMap((p)=>typeof p.number === 'number' && typeof p.title === 'string' ? [
            {
                number: p.number,
                title: p.title,
                isDraft: p.isDraft === true,
                updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
                url: typeof p.url === 'string' ? p.url : '',
                ci: ciOf(Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : [])
            }
        ] : []);
};
export const parseIssues = (json)=>{
    const d = parseJson('gh issue list output', json);
    if (!Array.isArray(d)) throw new Error('gh issue list output is not a list');
    return d.flatMap((i)=>typeof i.number === 'number' && typeof i.title === 'string' ? [
            {
                number: i.number,
                title: i.title,
                labels: Array.isArray(i.labels) ? i.labels.flatMap((l)=>typeof l.name === 'string' ? [
                        l.name
                    ] : []) : [],
                createdAt: typeof i.createdAt === 'string' ? i.createdAt : '',
                comments: Array.isArray(i.comments) ? i.comments.length : 0,
                url: typeof i.url === 'string' ? i.url : ''
            }
        ] : []);
};
const FEATURE_LABELS = new Set([
    'enhancement',
    'feature',
    'feature request',
    'question',
    'proposal'
]);
export const issueKind = (labels)=>labels.some((l)=>FEATURE_LABELS.has(l.toLowerCase())) ? 'feature' : 'defect';
export const PR_LIMIT = 10;
export const ISSUE_LIMIT = 100;
export const prListArgv = (repo)=>[
        'gh',
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--json',
        'number,title,isDraft,updatedAt,url,statusCheckRollup',
        '--limit',
        String(PR_LIMIT + 1)
    ];
export const prCountArgv = (repo)=>{
    const [owner = '', name = ''] = repo.split('/');
    return [
        'gh',
        'api',
        'graphql',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-f',
        'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN){totalCount}}}'
    ];
};
export const parsePrCount = (json)=>{
    const d = parseJson('gh api graphql output', json);
    const n = d?.data?.repository?.pullRequests?.totalCount;
    if (typeof n !== 'number') throw new Error('gh api graphql output has no pullRequests.totalCount');
    return n;
};
export const issueListArgv = (repo)=>[
        'gh',
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--json',
        'number,title,labels,createdAt,url,comments',
        '--limit',
        String(ISSUE_LIMIT)
    ];
export const remoteArgv = (local)=>[
        'git',
        '-C',
        local,
        'remote',
        'get-url',
        'origin'
    ];
export const prsLabel = (r)=>{
    const plural = (n)=>`${n} open PR${n === 1 ? '' : 's'}`;
    if (r.error !== null) return 'PRs: no reading';
    if (r.prTotal === null) return `${plural(r.prs.length)} shown, total not read (${r.prTotalError ?? 'no reason given'})`;
    return r.prTotal > r.prs.length ? `${r.prs.length} of ${r.prTotal} open PRs` : plural(r.prTotal);
};
export const reviewPrompt = (repo, pr)=>[
        `Review PR #${pr.number} of ${repo} ("${pr.title}", CI ${pr.ci}).`,
        'Read the diff and the CI logs for any red check. Post the review verdict as the lead: a standalone `gh pr comment` whose line 2 is the head sha.',
        'Merge only through merge-gate.py with --repo, and only when CI is green and the verdict is posted. Never merge, close or push from a mod.'
    ].join(' ');
export const takeIssuePrompt = (repo, issue)=>issueKind(issue.labels) === 'feature' ? [
        `Issue #${issue.number} of ${repo} ("${issue.title}") is a feature request.`,
        "Adding a feature needs the owner's decision: read the issue and its comments, then state in three sentences what it would change, what it costs and the alternative, and wait for the owner's answer before writing any code."
    ].join(' ') : [
        `Take issue #${issue.number} of ${repo} ("${issue.title}", ${issue.labels.length === 0 ? 'no label' : issue.labels.join(', ')}, ${issue.comments} comment${issue.comments === 1 ? '' : 's'}).`,
        'Read the issue and its comments, reproduce the defect on current main with a test that fails before the fix, fix the root cause in a worktree under <repo>/.claude/worktrees/ registered with disk-hygiene, run the gates exactly as CI runs them, and open a PR that closes it.',
        'Have the PR reviewed independently and merge only through merge-gate.py with --repo, once CI is green and the verdict is posted.',
        'Never close an issue without evidence: if the defect cannot be reproduced, say so with the commands run and ask the reporter on the issue.'
    ].join(' ');
export const draftIssuePrompt = (repos, l)=>[
        'From this session\'s harness signals, draft one GitHub issue on the plugin repository the signal belongs to:',
        `${l.refusals} guard refusals, ${l.classifierErrors} classifier errors, ${l.stuckEscalations} stuck escalations, ${l.leanCuts} tool results cut.`,
        `Candidate repositories: ${repos.join(', ')}.`,
        'Show me the issue title and body first; create it with `gh issue create` only after I confirm.'
    ].join(' ');
