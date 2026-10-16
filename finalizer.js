// The run and causal finalizers. Text helpers, the run summary, the causal
// normalisers and the causal summary live in lib/finalizer-*.js (#2170); this
// module keeps the public surface callers already import.

const { cleanFactText, extractText, normalizeEvidence, normalizeText } = require('./lib/finalizer-text');
const { buildFinalSummary, deriveMode } = require('./lib/finalizer-run-summary');
const { buildCausalSummary, deriveCausalRecommendation } = require('./lib/finalizer-causal-summary');

module.exports = {
  buildFinalSummary,
  buildCausalSummary,
  deriveCausalRecommendation,
  cleanFactText,
  deriveMode,
  extractText,
  normalizeEvidence,
  normalizeText,
};
