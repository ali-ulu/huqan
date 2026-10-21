'use strict';

const { keywordRelevance } = require('../cognitive-scheduler');
const { isPlainObject } = require('../is-plain-object');
const { AUTHORITY, clamp01, round6, freezeResult } = require('./contract');

const SCHEMA_VERSION = 'huqan-cognition-salience-v1';
const DEFAULT_WEIGHTS = Object.freeze({ surprise: 0.30, goal: 0.25, risk: 0.20, arousal: 0.15, novelty: 0.10, habituation: 0.20 });
const HABITUATION_HALF_LIFE = 3;
const RISK_SALIENCE = Object.freeze({ low: 0, medium: 0.5, high: 1 });
const FIELDS = ['key', 'family', 'perceptKey', 'predictionError', 'relevance', 'riskTier', 'arousal', 'seenCount', 'repeats'];
const text = (value) => typeof value === 'string' && value.trim() !== '';
const fraction = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function scoreCandidate(candidate, goal, weights) {
  const error = candidate.predictionError;
  const seenCount = count(candidate.seenCount);
  const repeats = count(candidate.repeats);
  const relevance = candidate.relevance === undefined || candidate.relevance === null
    ? text(goal) && text(candidate.family) ? keywordRelevance(goal, candidate) : null
    : fraction(candidate.relevance);
  const values = {
    surprise: isPlainObject(error) && (error.status === undefined || error.status === 'MEASURED') ? fraction(error.recentMean) : null,
    goal: relevance,
    risk: typeof candidate.riskTier === 'string' && Object.hasOwn(RISK_SALIENCE, candidate.riskTier) ? RISK_SALIENCE[candidate.riskTier] : null,
    arousal: fraction(candidate.arousal),
    novelty: seenCount === null ? null : 1 / (1 + seenCount),
    habituation: repeats === null ? null : 1 - 2 ** (-repeats / HABITUATION_HALF_LIFE),
  };
  const unknownComponents = Object.keys(values).filter((key) => values[key] === null);
  const components = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? 0 : round6(value)]));
  const measured = ['surprise', 'goal', 'risk'].some((key) => values[key] !== null);
  // The caller supplies scoped history counts; this pure scorer only ranks.
  const total = Object.keys(DEFAULT_WEIGHTS).reduce((sum, key) => sum + weights[key] * (values[key] ?? 0) * (key === 'habituation' ? -1 : 1), 0);
  return { key: candidate.key, status: measured ? 'MEASURED' : 'ABSTAIN', salience: measured ? round6(clamp01(total)) : null, components, unknownComponents };
}

function scoreSalience(input, options = {}) {
  const finish = (status, reason, ranked = [], weights = null) => freezeResult({
    schemaVersion: SCHEMA_VERSION, status, reason, ranked, weights, authority: AUTHORITY.SIGNAL_ONLY,
  });
  if (!isPlainObject(input) || !Array.isArray(input.candidates)
    || Object.keys(input).some((key) => !['goal', 'candidates'].includes(key))
    || (input.goal !== undefined && input.goal !== null && typeof input.goal !== 'string')) return finish('REJECT', 'invalid_input');
  if (!isPlainObject(options) || Object.keys(options).some((key) => key !== 'weights')) return finish('REJECT', 'invalid_options');
  const weights = Object.hasOwn(options, 'weights') ? options.weights : DEFAULT_WEIGHTS;
  if (!isPlainObject(weights) || Object.keys(weights).length !== Object.keys(DEFAULT_WEIGHTS).length
    || Object.keys(DEFAULT_WEIGHTS).some((key) => !Object.hasOwn(weights, key) || fraction(weights[key]) === null)) return finish('REJECT', 'invalid_weights');
  const keys = new Set();
  for (const candidate of input.candidates) {
    if (!isPlainObject(candidate) || !text(candidate.key) || candidate.key !== candidate.key.trim()
      || Object.keys(candidate).some((key) => !FIELDS.includes(key))) return finish('REJECT', 'invalid_candidate');
    if (keys.has(candidate.key)) return finish('REJECT', 'duplicate_key');
    keys.add(candidate.key);
  }
  const ranked = input.candidates.map((candidate) => scoreCandidate(candidate, input.goal, weights));
  ranked.sort((a, b) => (b.salience ?? -1) - (a.salience ?? -1) || a.key.localeCompare(b.key, 'en') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (ranked.length === 0) return finish('INSUFFICIENT', 'no_candidates', ranked, weights);
  const measured = ranked.some((candidate) => candidate.status === 'MEASURED');
  return finish(measured ? 'MEASURED' : 'ABSTAIN', measured ? 'scored_candidates' : 'primary_components_unknown', ranked, weights);
}

module.exports = { SCHEMA_VERSION, DEFAULT_WEIGHTS, HABITUATION_HALF_LIFE, scoreSalience };
