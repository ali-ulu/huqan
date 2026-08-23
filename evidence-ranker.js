// Null-prototype, so a type name is only ever looked up among the weights
// themselves.
//
// A plain object literal inherits from Object.prototype, so `WEIGHTS[type]`
// for 'constructor', 'toString', 'valueOf', 'hasOwnProperty' or '__proto__'
// returned a function (or the prototype) rather than undefined. `??` only
// catches null/undefined, so the 0.25 default never applied and the value
// flowed on into arithmetic (#1033).
const WEIGHTS = Object.freeze(Object.assign(Object.create(null), {
  user_opinion: 0.25,
  user_experience: 0.4,
  chat_memory: 0.45,
  blog: 0.5,
  docs: 0.6,
  benchmark: 0.7,
  experiment: 0.8,
  peer_reviewed: 0.9,
  replicated: 1.0,
}));

/**
 * The type check is not redundant with the null prototype: it keeps the
 * default applying if WEIGHTS is ever fed from somewhere else.
 */
function rankEvidence(type) {
  const weight = WEIGHTS[type];
  return typeof weight === 'number' && Number.isFinite(weight) ? weight : 0.25;
}

function adjustedConfidence(base, type) {
  const numericBase = Number(base);
  const safeBase = Number.isFinite(numericBase) ? numericBase : 0;
  const weighted = safeBase * rankEvidence(type);
  // NaN passes both comparisons below -- `NaN < 0` and `NaN > 1` are each
  // false -- so it used to leave here untouched, reaching callers as a
  // serialized `null` that cannot be told apart from "no confidence".
  if (!Number.isFinite(weighted)) return 0;
  if (weighted < 0) return 0;
  if (weighted > 1) return 1;
  return weighted;
}

module.exports = {
  WEIGHTS,
  rankEvidence,
  adjustedConfidence,
};
