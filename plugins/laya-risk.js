'use strict';

const SCOPE_THRESHOLD_DEFAULT = 0.5;

const LAYA_SCOPE_QUESTION = 'does this action match the workspace\'s declared scope';

const DECISION = Object.freeze({
  ALLOW: 'ALLOW',
  REVIEW: 'REVIEW',
  BLOCK: 'BLOCK',
});

function clamp01(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

// Laya contract: `noul` is P(true) — the probability that the positively-worded
// scope question is true. A high P(true) means the action IS in scope and must be
// ALLOWED. The previous mapping treated a high probability as a scope breach and
// sent it to review, which inverted the intended risk handling.
//
// Correct mapping:
//   noul >= threshold  -> inScope = true  -> ALLOW
//   noul <  threshold  -> inScope = false -> REVIEW
function evaluateScopeQuestion(input, opts = {}) {
  const threshold = clamp01(opts.threshold ?? SCOPE_THRESHOLD_DEFAULT, SCOPE_THRESHOLD_DEFAULT);
  const noul = clamp01(
    input == null ? undefined : input.noul ?? input.value ?? input.probability ?? input.score,
    undefined
  );

  const inScope = noul >= threshold;
  const decision = inScope ? DECISION.ALLOW : DECISION.REVIEW;

  return {
    ok: true,
    plugin: 'laya-risk',
    question: LAYA_SCOPE_QUESTION,
    noul,
    threshold,
    inScope,
    outOfScope: !inScope,
    boundary: noul === threshold,
    decision,
    reason: inScope
      ? 'P(true) meets threshold: action is in scope.'
      : 'P(true) below threshold: action is out of scope; send to review.',
  };
}

function isInScope(noul, threshold = SCOPE_THRESHOLD_DEFAULT) {
  return clamp01(noul) >= clamp01(threshold);
}

module.exports = {
  SCOPE_THRESHOLD_DEFAULT,
  LAYA_SCOPE_QUESTION,
  DECISION,
  clamp01,
  evaluateScopeQuestion,
  isInScope,
};
module.exports.evaluateScopeQuestion = evaluateScopeQuestion;
module.exports.isInScope = isInScope;
module.exports.default = evaluateScopeQuestion;
