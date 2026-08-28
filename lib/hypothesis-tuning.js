'use strict';

/**
 * Threshold tuning advice, derived from per-rule review feedback.
 *
 * lib/hypothesis-feedback.js says which rules people keep rejecting. This
 * turns that into a concrete threshold proposal — and stops there.
 *
 * ## Advice, never application
 *
 * Nothing here writes a threshold, a config file, or anything else. The
 * output is a proposal a person reads and decides on. Making the engine
 * change its own thresholds is a materially different thing to build, with
 * its own admission and approval story; it is deliberately not this module.
 *
 * ## Only the thresholds that exist
 *
 * `generateHypotheses` accepts exactly three tunable options. Every
 * suggestion names one of them and stays inside the bounds that function
 * enforces, so a suggestion a person applies verbatim cannot be silently
 * clamped back to the default.
 *
 * ## Suggestions only quieten a rule
 *
 * A rule people keep rejecting is firing too often, and the proposal moves
 * its threshold so it fires less. The opposite move — loosening a threshold
 * because a rule is mostly accepted — is not made here: acceptance says the
 * findings were right, not that more findings are waiting, and inferring the
 * second from the first is how a tuner starts amplifying its own output.
 */

const { DEFAULTS } = require('./graph-hypotheses');

/** Below this many verdicts a rule has not been judged enough to tune on. */
const MIN_REVIEWED = 5;

/** Above this rejection rate a rule counts as noisy. Equality does not fire. */
const REJECTION_TRIGGER = 0.6;

/**
 * Rule -> the option that quietens it, and the direction that does so.
 *
 * `ZAYIF_BAĞ` fires on `confidence < confidenceFloor`, so a lower floor
 * flags fewer edges. `KRİTİK_DÜĞÜM` fires on `inDegree >= criticalInDegree`,
 * so a higher threshold flags fewer nodes. `KÜÇÜK_BİLEŞEN` fires on
 * `size <= smallComponentSize`, so a smaller size flags fewer components.
 *
 * The three remaining rules have no threshold at all — they are structural —
 * and are reported as untunable rather than dropped.
 */
const TUNABLE_OPTIONS = Object.freeze({
  'ZAYIF_BAĞ': Object.freeze({
    option: 'confidenceFloor',
    step: -0.05,
    min: 0,
    max: 1,
    integer: false,
    quieter: 'daha az kenar zayıf sayılır',
  }),
  'KRİTİK_DÜĞÜM': Object.freeze({
    option: 'criticalInDegree',
    step: 1,
    min: 1,
    max: Number.POSITIVE_INFINITY,
    integer: true,
    quieter: 'daha az düğüm kritik sayılır',
  }),
  'KÜÇÜK_BİLEŞEN': Object.freeze({
    option: 'smallComponentSize',
    step: -1,
    min: 2,
    max: Number.POSITIVE_INFINITY,
    integer: true,
    quieter: 'daha az bileşen küçük sayılır',
  }),
});

/** Kept off floating-point noise so repeated runs return identical numbers. */
function round(value, integer) {
  return integer ? Math.round(value) : Math.round(value * 100) / 100;
}

function currentValueFor(spec, overrides) {
  const supplied = overrides[spec.option];
  return Number.isFinite(supplied) ? supplied : DEFAULTS[spec.option];
}

/**
 * @param {{rules: object[], meta?: object}} feedback output of buildFeedbackStats
 * @param {object} [currentOptions] the thresholds in force, if not the defaults
 * @returns {{meta: object, suggestions: object[], skipped: object[], applied: false}} deterministic; both lists sorted by rule type.
 */
function buildTuningAdvice(feedback = {}, currentOptions = {}) {
  const rules = Array.isArray(feedback.rules) ? feedback.rules : [];
  const overrides = currentOptions && typeof currentOptions === 'object' ? currentOptions : {};
  const suggestions = [];
  const skipped = [];

  for (const rule of [...rules].sort((left, right) => left.ruleType.localeCompare(right.ruleType))) {
    const spec = TUNABLE_OPTIONS[rule.ruleType];
    if (!spec) {
      skipped.push({ ruleType: rule.ruleType, reason: 'no_tunable_threshold', reviewed: rule.reviewed });
      continue;
    }
    if (!Number.isFinite(rule.reviewed) || rule.reviewed < MIN_REVIEWED) {
      skipped.push({ ruleType: rule.ruleType, reason: 'insufficient_data', reviewed: rule.reviewed || 0 });
      continue;
    }
    if (!Number.isFinite(rule.rejectionRate) || rule.rejectionRate <= REJECTION_TRIGGER) {
      skipped.push({ ruleType: rule.ruleType, reason: 'within_tolerance', reviewed: rule.reviewed, rejectionRate: rule.rejectionRate });
      continue;
    }

    const currentValue = currentValueFor(spec, overrides);
    const suggestedValue = round(
      Math.min(spec.max, Math.max(spec.min, currentValue + spec.step)),
      spec.integer,
    );
    if (suggestedValue === currentValue) {
      // Clamped onto the current value: the threshold is already as quiet as
      // generateHypotheses allows, and repeating it back is not advice.
      skipped.push({ ruleType: rule.ruleType, reason: 'already_at_bound', reviewed: rule.reviewed, currentValue });
      continue;
    }

    const percent = Math.round(rule.rejectionRate * 100);
    suggestions.push({
      ruleType: rule.ruleType,
      option: spec.option,
      currentValue,
      suggestedValue,
      reviewed: rule.reviewed,
      rejectionRate: rule.rejectionRate,
      reason: `${rule.ruleType} bulgularının %${percent}'i reddedildi (${rule.rejected}/${rule.reviewed}); `
        + `${spec.option} ${currentValue} -> ${suggestedValue} yapılırsa ${spec.quieter}.`,
    });
  }

  return {
    meta: {
      workspaceId: feedback.meta?.workspaceId || 'default',
      minReviewed: MIN_REVIEWED,
      rejectionTrigger: REJECTION_TRIGGER,
    },
    suggestions,
    skipped,
    // Stated in the payload, not just in prose: a consumer should not have to
    // read the docs to learn that nothing was changed.
    applied: false,
  };
}

module.exports = {
  MIN_REVIEWED,
  REJECTION_TRIGGER,
  TUNABLE_OPTIONS,
  buildTuningAdvice,
};
