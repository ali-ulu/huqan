'use strict';

/**
 * F2 — robustness-lite: a status-aware stress probe over verify().
 *
 * F0-B measured that HUQAN's verify confidence is "confidence in the
 * verdict", not "amount of support": under contradiction injection the
 * status flips to `contradicted` while confidence stays HIGH (0.9+). A
 * naive confidence-decay metric therefore scores a correctly-flipping
 * claim as perfectly robust AND a never-flipping claim the same way.
 * This probe scores the flip, not the number:
 *
 *   - negation axis: does the negated claim come back `contradicted`?
 *   - value-swap axis: does a changed number / swapped entity stop
 *     verifying? (`contradicted` or `unknown` both count as sensitive)
 *
 * Pure, deterministic, zero-dependency. Takes a verify function, never a
 * kernel, so it cannot write to any graph. NOT_YET_WIRED (see
 * lib/module-reachability.js): production wiring lands in F3.
 */

const { OPPOSITION_PAIRS } = require('../contradiction-rules');

const ROBUSTNESS_VERSION = 'robustness-lite-v1';

// Axis weights: falsifiability first. A claim no negation can contradict
// is the most dangerous shape (it can never lose), so the negation axis
// carries half the score on its own.
const AXIS_PENALTY = Object.freeze({
  negation: 0.5,
  valueSwap: 0.3,
  entitySwap: 0.2,
});

const TR_COPULA_TAILS = ['dır', 'dir', 'dur', 'dür', 'tır', 'tir', 'tur', 'tür'];

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function unwrapVerifyResult(result) {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') return result.data;
  return result && typeof result === 'object' ? result : {};
}

function safeVerify(verify, statement, opts = {}) {
  const raw = verify(statement, opts);
  const data = unwrapVerifyResult(raw);
  return {
    status: typeof data.status === 'string' ? data.status : 'unknown',
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
  };
}

/**
 * Negate a statement. TR copula ("Kedi hayvandır" -> "Kedi hayvan
 * değildir"), TR explicit negation ("... değildir" -> affirmative), EN
 * is/are ("X is Y" -> "X is not Y"). Returns null when no rule applies;
 * an inapplicable axis is skipped, never penalized.
 */
function negateStatement(statement) {
  if (typeof statement !== 'string') return null;
  const text = statement.trim();
  if (!text) return null;
  const negTail = /(?:^|\s)(değildir|degildir|değil|degil)\s*$/i;
  if (negTail.test(text)) {
    const affirmed = text.replace(negTail, '').trim();
    return affirmed || null;
  }
  const lower = text.toLocaleLowerCase('tr-TR');
  for (const tail of TR_COPULA_TAILS) {
    if (lower.endsWith(tail)) {
      const cut = text.slice(0, text.length - tail.length).trim();
      if (cut) return `${cut} değildir`;
    }
  }
  const enIs = /\bis\b/i;
  if (enIs.test(text)) return text.replace(enIs, (m) => `${m} not`);
  const enAre = /\bare\b/i;
  if (enAre.test(text)) return text.replace(enAre, (m) => `${m} not`);
  return null;
}

/** Swap the first integer in the statement for its half (min 1, 0 -> 1). Null when no number. */
function swapNumericValue(statement) {
  if (typeof statement !== 'string') return null;
  const match = statement.match(/\d+/);
  if (!match) return null;
  const value = Number.parseInt(match[0], 10);
  const swapped = value === 0 ? 1 : Math.max(1, Math.round(value / 2));
  if (swapped === value) return null;
  return statement.slice(0, match.index) + String(swapped) + statement.slice(match.index + match[0].length);
}

/** Swap the first OPPOSITION_PAIRS term for its mate. Null when none present. */
function swapEntity(statement) {
  if (typeof statement !== 'string') return null;
  const folded = ` ${statement.toLocaleLowerCase('tr-TR')} `;
  for (const [a, b] of OPPOSITION_PAIRS) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const needle = ` ${String(from).toLocaleLowerCase('tr-TR')} `;
      const at = folded.indexOf(needle);
      if (at >= 0) {
        // `folded` is ' ' + statement, and `at` points at needle's leading
        // space, so the word starts at `at` in statement coordinates.
        const start = at;
        return statement.slice(0, start) + to + statement.slice(start + from.length);
      }
    }
  }
  return null;
}

function runRobustnessProbe(verify, statement, opts = {}) {
  if (typeof verify !== 'function') throw new TypeError('runRobustnessProbe requires a verify function');
  const workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim()
    ? opts.workspaceId.trim()
    : 'default';
  const baseline = safeVerify(verify, statement, { workspaceId, ...opts.verifyOpts });
  const axes = [];

  if (baseline.status !== 'verified') {
    return {
      version: ROBUSTNESS_VERSION,
      statement: String(statement || ''),
      workspaceId,
      applicable: false,
      reason: `baseline_not_verified (status: ${baseline.status})`,
      baseline,
      axes,
      score: null,
      flags: ['BASELINE_NOT_VERIFIED'],
    };
  }

  const stressors = [
    { axis: 'negation', variant: negateStatement(statement), passWhen: (s) => s === 'contradicted', flag: 'FRAGILE_UNFALSIFIABLE' },
    { axis: 'valueSwap', variant: swapNumericValue(statement), passWhen: (s) => s !== 'verified', flag: 'INSENSITIVE_TO_VALUE' },
    { axis: 'entitySwap', variant: swapEntity(statement), passWhen: (s) => s !== 'verified', flag: 'INSENSITIVE_TO_ENTITY' },
  ];

  const flags = [];
  let score = 1;
  for (const stressor of stressors) {
    if (stressor.variant === null || stressor.variant === statement) continue;
    const stressed = safeVerify(verify, stressor.variant, { workspaceId, ...opts.verifyOpts });
    const pass = stressor.passWhen(stressed.status);
    axes.push({
      axis: stressor.axis,
      variant: stressor.variant,
      baselineStatus: baseline.status,
      stressedStatus: stressed.status,
      baselineConfidence: baseline.confidence,
      stressedConfidence: stressed.confidence,
      pass,
    });
    if (!pass) {
      score = Math.max(0, score - AXIS_PENALTY[stressor.axis]);
      flags.push(stressor.flag);
    }
  }

  if (axes.length === 0) {
    return {
      version: ROBUSTNESS_VERSION,
      statement: String(statement || ''),
      workspaceId,
      applicable: false,
      reason: 'no_stressor_applicable',
      baseline,
      axes,
      score: null,
      flags: ['NO_STRESSOR_APPLICABLE'],
    };
  }

  return {
    version: ROBUSTNESS_VERSION,
    statement: String(statement || ''),
    workspaceId,
    applicable: true,
    reason: '',
    baseline,
    axes,
    score: Math.round(score * 100) / 100,
    flags,
  };
}

module.exports = {
  ROBUSTNESS_VERSION,
  AXIS_PENALTY,
  negateStatement,
  swapNumericValue,
  swapEntity,
  runRobustnessProbe,
};
