'use strict';

/**
 * Exact interval helpers for the G3 real-source measurements (#4432, #4433).
 *
 * Both frozen protocols require an *exact* (Clopper-Pearson) one-sided bound
 * rather than a normal approximation: a zero-variance sample would let the
 * normal interval report a false PASS (#4422 lesson), and a percentile bootstrap
 * degenerates to `[0, 0]` at zero variance, which is the same false PASS. The
 * regularized incomplete beta is computed by continued fraction (Lentz), and the
 * Clopper-Pearson bounds invert it by bisection, so the bounds are honest at any
 * sample size, including `n` far below the asymptotics.
 */

const Z = Object.freeze({ ALPHA_ONE_SIDED: 0.05 });

const GAMMA_COF = [76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];

function logGamma(x) {
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) ser += GAMMA_COF[j] / (x + 1 + j);
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Continued-fraction evaluation of the incomplete beta (Numerical Recipes).
function betaContinuedFraction(a, b, x) {
  const MAX_ITERATIONS = 300;
  const EPSILON = 3e-14;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function regularizedIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** The `p` where the Beta(a, b) CDF equals `target`, by bisection on [0, 1]. */
function betaQuantile(a, b, target) {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (regularizedIncompleteBeta(a, b, mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Exact one-sided lower bound on a proportion from `successes` of `trials`. */
function clopperPearsonLower(successes, trials, alpha = Z.ALPHA_ONE_SIDED) {
  if (!Number.isInteger(trials) || trials <= 0) throw new TypeError('CP_TRIALS_INVALID');
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) throw new TypeError('CP_SUCCESSES_INVALID');
  if (successes === 0) return 0;
  return betaQuantile(successes, trials - successes + 1, alpha);
}

/** Exact one-sided upper bound on a proportion from `successes` of `trials`. */
function clopperPearsonUpper(successes, trials, alpha = Z.ALPHA_ONE_SIDED) {
  if (!Number.isInteger(trials) || trials <= 0) throw new TypeError('CP_TRIALS_INVALID');
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) throw new TypeError('CP_SUCCESSES_INVALID');
  if (successes === trials) return 1;
  return betaQuantile(successes + 1, trials - successes, 1 - alpha);
}

/**
 * Newcombe's method 10 lower bound for the difference `p1 - p2`. It combines the
 * exact Clopper-Pearson intervals of the two arms, so it stays valid at small
 * samples and at zero observed difference, where a normal or bootstrap interval
 * would report a false non-inferiority.
 */
function newcombeDifferenceLower(x1, n1, x2, n2, alpha = Z.ALPHA_ONE_SIDED) {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const l1 = clopperPearsonLower(x1, n1, alpha);
  const u2 = clopperPearsonUpper(x2, n2, alpha);
  return (p1 - p2) - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2);
}

/** Newcombe's method 10 upper bound for the difference `p1 - p2`. */
function newcombeDifferenceUpper(x1, n1, x2, n2, alpha = Z.ALPHA_ONE_SIDED) {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const u1 = clopperPearsonUpper(x1, n1, alpha);
  const l2 = clopperPearsonLower(x2, n2, alpha);
  return (p1 - p2) + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2);
}

module.exports = Object.freeze({
  ALPHA_ONE_SIDED: Z.ALPHA_ONE_SIDED,
  logGamma, regularizedIncompleteBeta, betaQuantile,
  clopperPearsonLower, clopperPearsonUpper,
  newcombeDifferenceLower, newcombeDifferenceUpper,
});
