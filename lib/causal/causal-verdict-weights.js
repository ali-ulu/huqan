'use strict';

// Verdict status vocabulary, version stamp and scoring weights for the
// causal verdict. Split out of lib/causal/causal-verdict.js (#2175) so the
// constants can be tuned without touching the scoring logic; the names
// document intent.

const CAUSAL_VERDICT_STATUSES = Object.freeze([
  'supports',
  'contradicts',
  'inconclusive',
  'cycle_blocked',
  'depth_incomplete',
]);

const CAUSAL_VERDICT_VERSION = '1.0.0';

const SUPPORT_RELATION_TYPES = Object.freeze(['CAUSES', 'ENABLES', 'LEADS_TO', 'DEPENDS_ON']);

// Scoring weights for scoreCausalVerdict. Centralized so they can be tuned
// without touching the scoring logic and so the names document intent.
const CAUSAL_SCORE_WEIGHTS = Object.freeze({
  BASE_CONFIDENCE: 0.33,
  EVIDENCE_MULTIPLIER: 0.35,
  MAX_SUPPORT_COVERAGE_BONUS: 0.25,
  SUPPORT_COVERAGE_DIVISOR: 5,
  MAX_PREVENT_PENALTY: 0.18,
  PREVENT_PENALTY_PER_EDGE: 0.06,
  MAX_WARNING_PENALTY: 0.18,
  WARNING_PENALTY_PER_WARNING: 0.03,
  MAX_BRANCH_PENALTY: 0.2,
  BRANCH_PENALTY_PER_BRANCH: 0.05,
  DEFAULT_EDGE_CONFIDENCE: 0.5,
  STATUS_BONUS_SUPPORTS: 0.12,
  STATUS_BONUS_CONTRADICTS: 0.22,
  STATUS_PENALTY_DEPTH_INCOMPLETE: -0.08,
  STATUS_PENALTY_CYCLE_BLOCKED: -0.24,
  STATUS_PENALTY_INCONCLUSIVE: -0.12,
  FALLBACK_CONFIDENCE: 0.33,
});

module.exports = {
  CAUSAL_VERDICT_STATUSES,
  CAUSAL_VERDICT_VERSION,
  SUPPORT_RELATION_TYPES,
  CAUSAL_SCORE_WEIGHTS,
};
