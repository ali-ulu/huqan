// Contradiction rules: runs every detector over a stored and an incoming
// claim and collects their signals. Vocabulary, text helpers and the
// detectors live in contradiction-rules-*.js (#2178).

const { detectNegationConflict, detectRelationInversion, detectSemanticOpposition, detectUnitConflict } = require('./contradiction-rules-opposition-detectors');
const { detectCausePreventOpposition, detectNumericalConflict, detectPredicateDrift, detectTypeConflict, detectValueConflict } = require('./contradiction-rules-value-detectors');
const { CONTRADICTION_RULES, NEGATION_TOKENS, OPPOSITION_PAIRS, TYPE_DISJOINTS } = require('./contradiction-rules-vocabulary');

function runContradictionRules(stored, incoming, opts = {}) {
  const rules = [
    detectNumericalConflict(stored, incoming, opts),
    detectValueConflict(stored, incoming, opts),
    detectTypeConflict(stored, incoming, opts),
    detectNegationConflict(stored, incoming, opts),
    detectUnitConflict(stored, incoming, opts),
    detectCausePreventOpposition(stored, incoming, opts),
    detectSemanticOpposition(stored, incoming, opts),
    detectRelationInversion(stored, incoming, opts),
    detectPredicateDrift(stored, incoming, opts),
  ];

  return rules.filter(Boolean);
}

module.exports = {
  CONTRADICTION_RULES,
  NEGATION_TOKENS,
  OPPOSITION_PAIRS,
  TYPE_DISJOINTS,
  detectNumericalConflict,
  detectValueConflict,
  detectTypeConflict,
  detectPredicateDrift,
  detectNegationConflict,
  detectUnitConflict,
  detectRelationInversion,
  detectSemanticOpposition,
  runContradictionRules,
};
