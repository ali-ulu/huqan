'use strict';

// Shared primitives and hypothesis shaping for lib/dream-experiment-loop.js
// (#2120): bounded helpers, hypothesis normalization and extraction live here;
// the entry file composes them and owns the public surface.

const crypto = require('crypto');

const DREAM_EXPERIMENT_LOOP_VERSION = 'DEL-v1.0.0';
const MAX_HYPOTHESES = 10;
const DEFAULT_MAX_HYPOTHESES = 3;
const DEFAULT_MAX_CYCLES = 2;
const MAX_TEXT = 240;

function boundedText(value, max = MAX_TEXT) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return text.slice(0, max);
}

function boundedConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function relationForHypothesis(hypothesis = {}) {
  if (['tür', 'yapabilir', 'özellik', 'benzer', 'hipotez'].includes(hypothesis.relation)) {
    return hypothesis.relation;
  }
  if (hypothesis.via === 'tür') return 'tür';
  if (hypothesis.via === 'yapabilir') return 'yapabilir';
  if (hypothesis.via === 'özellik') return 'özellik';
  if (hypothesis.type === 'zincir' || hypothesis.type === 'benzerlik') return 'benzer';
  return 'hipotez';
}

function normalizeHypothesis(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const from = boundedText(raw.from || raw.subject || raw.node, 120);
  const to = boundedText(raw.to || raw.target, 120);
  if (!from || !to) return null;
  const relation = relationForHypothesis(raw);
  const type = boundedText(raw.type || raw.via || 'hypothesis', 60) || 'hypothesis';
  const confidence = boundedConfidence(raw.confidence);
  const key = hashId(`${from}|${relation}|${to}`);
  return {
    key,
    from,
    to,
    relation,
    type,
    via: boundedText(raw.via || '', 60),
    confidence,
    claim: `${from} ${relation} ${to}`.slice(0, MAX_TEXT),
  };
}

function extractHypotheses(dreamResult) {
  const candidates = Array.isArray(dreamResult)
    ? dreamResult
    : Array.isArray(dreamResult?.data?.hypotheses)
      ? dreamResult.data.hypotheses
      : Array.isArray(dreamResult?.hypotheses)
        ? dreamResult.hypotheses
        : [];
  const seen = new Set();
  return candidates
    .map(normalizeHypothesis)
    .filter(Boolean)
    .filter(item => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .sort((left, right) => right.confidence - left.confidence || left.key.localeCompare(right.key))
    .slice(0, MAX_HYPOTHESES);
}

module.exports = {
  DREAM_EXPERIMENT_LOOP_VERSION,
  MAX_HYPOTHESES,
  DEFAULT_MAX_HYPOTHESES,
  DEFAULT_MAX_CYCLES,
  MAX_TEXT,
  boundedText,
  boundedConfidence,
  cloneValue,
  hashId,
  relationForHypothesis,
  normalizeHypothesis,
  extractHypotheses,
};
