// The two answers become one decision. Pure. Both models answered: the higher class wins, so a brief that steers
// one model down is still read by the other. One answered: it decides and the reason names the missing one and why.
// Neither answered: `none`, and the caller asks the user. The agent type then bounds the class (route.ts bound).

import { bound, higher } from './route'
import type { Brief, Class } from './route'

export type Seen = { ok: true; cls: Class; detail: string } | { ok: false; why: string }
export type Verdict = { cls: Class; by: 'fm' | 'jev' | 'fm+jev'; reason: string }
export type Nothing = { none: string }

export function combine(fm: Seen, jev: Seen, task: Brief): Verdict | Nothing {
  if (!fm.ok && !jev.ok) return { none: `fm: ${fm.why}; jev: ${jev.why}` }
  let cls: Class
  let by: Verdict['by']
  let said: string
  if (fm.ok && jev.ok) {
    cls = higher(fm.cls, jev.cls)
    by = 'fm+jev'
    said = `max(fm ${fm.cls} "${fm.detail}", jev ${jev.cls} ${jev.detail})`
  } else if (fm.ok) {
    cls = fm.cls
    by = 'fm'
    said = `fm ${fm.cls} "${fm.detail}"; jev missing: ${jev.ok ? '' : jev.why}`
  } else if (jev.ok) {
    cls = jev.cls
    by = 'jev'
    said = `jev ${jev.cls} ${jev.detail}; fm missing: ${fm.ok ? '' : fm.why}`
  } else {
    return { none: 'unreachable' }
  }
  const b = bound(cls, task)
  const note = b.note === undefined ? '' : ` [${b.note} from ${cls} by the agent type]`
  return { cls: b.cls, by, reason: `${b.cls}: ${said}${note}` }
}
