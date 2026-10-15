// The statistics the learning loop decides with. Pure. Every constant is either a quantile of a
// named distribution or the one stated choice (HALF_WIDTH) the others are derived from.

// source: the standard normal quantile Phi^-1(0.95) = 1.6449, a one-sided 95% bound: a proposal acts on
// "the rate is above / below this" at 95% confidence, one direction at a time.
export const Z = 1.645 // source: Phi^-1(0.95), the standard normal one-sided 95% quantile

// source: own choice, the only free parameter: the precision at which a rate must be resolved before
// it can be acted on (the 90% interval's half-width, 10 points). Everything below is derived from it:
// stepsFor(0.25) = 51 steps replaces the old unexplained MIN_STEPS = 40.
export const HALF_WIDTH = 0.1 // source: own choice, stated above; the one free parameter

export type Interval = { p: number; lo: number; hi: number; n: number }

// Wilson score interval of k successes in n trials. source: Wilson 1927, "Probable inference, the law
// of succession, and statistical inference", JASA 22:209-212; recommended over the Wald interval for
// small n and rates near 0 or 1 by Brown, Cai & DasGupta 2001, Statistical Science 16(2):101-133.
// n = 0 knows nothing: [0, 1]. The trials are taken as independent; steps of one turn or one session
// are not entirely (callers report the sessions beside the interval and test its stability by session).
export const wilson = (k: number, n: number, z: number = Z): Interval => {
  if (n <= 0) return { p: 0, lo: 0, hi: 1, n: 0 }
  const p = k / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n }
}

export type Tally = { k: number; n: number }
export type Difference = { d: number; lo: number; hi: number }

// Interval of p(a) - p(b), the two rates from independent samples. source: Newcombe 1998, "Interval
// estimation for the difference between independent proportions: comparison of eleven methods",
// Statistics in Medicine 17:873-890, method 10 (the Wilson limits of each rate combined). Checked on
// Newcombe's own example in stats.test.ts. A side with no trials gives the widest interval.
export const newcombe = (a: Tally, b: Tally, z: number = Z): Difference => {
  const ia = wilson(a.k, a.n, z)
  const ib = wilson(b.k, b.n, z)
  const d = ia.p - ib.p
  return { d, lo: d - Math.sqrt((ia.p - ia.lo) ** 2 + (ib.hi - ib.p) ** 2), hi: d + Math.sqrt((ia.hi - ia.p) ** 2 + (ib.p - ib.lo) ** 2) }
}

// Trials needed to resolve a rate p to within +-h at z: n = z^2 p (1 - p) / h^2 (the normal
// approximation of the interval's half-width). source: any survey-sampling text, e.g. Cochran 1977,
// Sampling Techniques, 3rd ed., eq. 4.2. stepsFor(0.25) = 51, stepsFor(0.05) = 13, the maximum is at 0.5 (68).
export const stepsFor = (p: number, h: number = HALF_WIDTH, z: number = Z): number => Math.ceil((z * z * p * (1 - p)) / (h * h))

// A rate is resolved when its interval is narrower than the precision asked for.
export const isResolved = (iv: Interval, h: number = HALF_WIDTH): boolean => iv.n > 0 && (iv.hi - iv.lo) / 2 <= h
