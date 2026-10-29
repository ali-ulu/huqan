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
// Declared input budget for the curiosity path (#4071 section 5). The legacy
// confidence path keeps its exact behaviour; only a ranked pool is bounded.
const MAX_DREAM_CANDIDATES = 200;
const CURIOSITY_FIELDS = Object.freeze(['curiosity', 'learningProgress', 'learningProgressStatus', 'explorationBonus', 'noiseGuard', 'score']);

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
  const region = boundedText(raw.region || '', 60);
  const key = hashId(`${from}|${relation}|${to}`);
  return {
    key,
    from,
    to,
    relation,
    type,
    via: boundedText(raw.via || '', 60),
    confidence,
    // #4071: the monitoring region a hypothesis competes in. Absent in legacy
    // input, so the normalized shape only grows when the producer supplies it.
    ...(region ? { region } : {}),
    claim: `${from} ${relation} ${to}`.slice(0, MAX_TEXT),
  };
}

function candidatePool(dreamResult) {
  return Array.isArray(dreamResult)
    ? dreamResult
    : Array.isArray(dreamResult?.data?.hypotheses)
      ? dreamResult.data.hypotheses
      : Array.isArray(dreamResult?.hypotheses)
        ? dreamResult.hypotheses
        : [];
}

const byConfidence = (left, right) => right.confidence - left.confidence || left.key.localeCompare(right.key);

function normalizedCandidates(candidates) {
  const seen = new Set();
  return candidates
    .map(normalizeHypothesis)
    .filter(Boolean)
    .filter(item => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
}

function extractHypotheses(dreamResult) {
  return normalizedCandidates(candidatePool(dreamResult)).sort(byConfidence).slice(0, MAX_HYPOTHESES);
}

const curiosityOf = (row) => Object.fromEntries(CURIOSITY_FIELDS
  .filter(field => row[field] !== undefined)
  .map(field => [field, row[field]]));

/**
 * #4071: normalize/dedup -> curiosity ranker -> MAX_HYPOTHESES/maxHypotheses
 * selection. The ranker runs before both cuts, so a low-confidence candidate
 * ranked into the top band is not dropped by the confidence cut. A ranker that
 * adds, drops or renames a candidate is rejected and the confidence order is
 * kept, so a broken ranker can never widen the selected set.
 */
function selectHypotheses(dreamResult, { rankHypotheses, history, maxHypotheses } = {}) {
  const bounded = Number.isInteger(maxHypotheses)
    ? Math.max(1, Math.min(MAX_HYPOTHESES, maxHypotheses))
    : DEFAULT_MAX_HYPOTHESES;
  if (typeof rankHypotheses !== 'function') {
    return { hypotheses: extractHypotheses(dreamResult).slice(0, bounded), curiosity: null };
  }
  const raw = candidatePool(dreamResult);
  const pool = normalizedCandidates(raw.slice(0, MAX_DREAM_CANDIDATES)).sort(byConfidence);
  const meta = { pooled: pool.length, truncated: raw.length > MAX_DREAM_CANDIDATES };
  const result = rankHypotheses(pool, { history });
  const ranked = result && Array.isArray(result.ranked) ? result.ranked : null;
  const rows = new Map();
  let malformed = !ranked;
  for (const row of ranked || []) {
    if (!row || typeof row.key !== 'string' || rows.has(row.key)) {
      malformed = true;
      break;
    }
    rows.set(row.key, row);
  }
  const invalid = malformed || rows.size !== pool.length || pool.some(item => !rows.has(item.key));
  if (invalid) {
    return { hypotheses: pool.slice(0, bounded), curiosity: { status: 'REJECT', reason: 'ranker_changed_candidate_set', ...meta } };
  }
  if (result.status === 'ABSTAIN' || result.status === 'REJECT') {
    return { hypotheses: pool.slice(0, bounded), curiosity: { status: result.status, reason: result.reason, ...meta } };
  }
  const order = new Map(ranked.map((row, index) => [row.key, index]));
  const ordered = pool
    .map(item => ({ ...item, curiosity: curiosityOf(rows.get(item.key)) }))
    .sort((left, right) => order.get(left.key) - order.get(right.key));
  return { hypotheses: ordered.slice(0, bounded), curiosity: { status: result.status, reason: result.reason, ...meta } };
}

module.exports = {
  DREAM_EXPERIMENT_LOOP_VERSION,
  MAX_HYPOTHESES,
  DEFAULT_MAX_HYPOTHESES,
  DEFAULT_MAX_CYCLES,
  MAX_TEXT,
  MAX_DREAM_CANDIDATES,
  boundedText,
  boundedConfidence,
  cloneValue,
  hashId,
  relationForHypothesis,
  normalizeHypothesis,
  extractHypotheses,
  selectHypotheses,
};
