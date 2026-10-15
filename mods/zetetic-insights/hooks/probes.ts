// Which sessions are probes (a test of the harness, not work): kept out of learning, still counted.
// Pure. One rule, written once here; the register stamps the origin on every record, the replay of an
// old ledger reads the transcript path the store kept.

import type { ProbeReason, TurnRecord } from '../types'

// source: macOS and Linux temp roots (`/tmp` -> `/private/tmp`, `$TMPDIR` under /var/folders), the
// directories `claude -p` probes and the harness's own scratch runs were found in (audit
// 2026-10-15: 9 of 20 probe sessions under /private/tmp, the 6 others under a scratch path); the
// caller adds the process's TMPDIR, TEMP and TMP.
export const TEMP_ROOTS: readonly string[] = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders']

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export const isUnderTemp = (cwd: string, extraRoots: readonly string[] = []): boolean => {
  const dir = norm(cwd)
  return [...TEMP_ROOTS, ...extraRoots].map(norm).filter((r) => r !== '').some((r) => dir === r || dir.startsWith(`${r}/`))
}

// A transcript path is `<config>/projects/<cwd with / and . as ->/<session>.jsonl`: the folder name
// is the working directory of the session. Only the temp roots' encodings are read from it.
export const tempProjectDir = (transcript: string): boolean => {
  const m = /\/projects\/([^/]+)\/[^/]+$/.exec(transcript.replace(/\\/g, '/'))
  return m !== null && /^-(?:private-)?(?:tmp|var-tmp|var-folders)(?:-|$)/.test(m[1]!)
}

export type ProbeInfo = { probe: boolean; reason: ProbeReason | null; steps: number }

// A session is a probe when (1) its working directory is under the OS temp dir (stamped on its
// records, or read from its transcript path), whatever its length; or (2) it was non-interactive (a
// `-p` run or the SDK) and took at most one main step; or (3) nothing is known of its origin
// (records written before the origin was kept) and it is a single main step with no agent. The step
// count is main's steps, not turns: a 1-turn session of 3 steps is work.
export const probeOf = (records: readonly TurnRecord[], transcript?: string): ProbeInfo => {
  const steps = records.reduce((n, r) => n + r.main.reduce((m, run) => m + run.steps, 0), 0)
  const agents = records.some((r) => r.agents.length > 0)
  const stamped = records.some((r) => r.nonInteractive !== undefined || r.tmpCwd === true)
  if (records.some((r) => r.tmpCwd === true) || (transcript !== undefined && tempProjectDir(transcript))) return { probe: true, reason: 'temp-cwd', steps }
  if (records.some((r) => r.nonInteractive === true) && steps <= 1) return { probe: true, reason: 'non-interactive-1-step', steps }
  if (!stamped && steps <= 1 && !agents) return { probe: true, reason: 'one-step-unknown', steps }
  return { probe: false, reason: null, steps }
}

export const probesOf = (records: readonly TurnRecord[], transcripts: ReadonlyMap<string, string> = new Map()): Map<string, ProbeInfo> => {
  const by = new Map<string, TurnRecord[]>()
  for (const r of records) by.set(r.session, [...(by.get(r.session) ?? []), r])
  return new Map([...by].map(([s, rs]) => [s, probeOf(rs, transcripts.get(s))]))
}

export const withoutProbes = <T extends { session: string }>(records: readonly T[], probes: ReadonlyMap<string, ProbeInfo>): T[] => records.filter((r) => probes.get(r.session)?.probe !== true)
