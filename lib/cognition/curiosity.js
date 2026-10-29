'use strict';

/**
 * COG-M10 (#4071): learning-progress curiosity over Dream hypotheses.
 *
 * Pure Core: no I/O, no clock, no randomness. The ranker only reorders the
 * normalized candidates it is given; it never adds, drops or acts on one, and
 * its output is signal-only. Learning progress is measured only when the same
 * frozen monitoring probe set carries errors from two different predictor
 * versions, so an easier task mix under an unchanged predictor never reads as
 * learning. The exploration bonus is a heuristic, not evidence of learning.
 */

const { COGNITION_STATUS, AUTHORITY, clamp01, round6, freezeResult } = require('./contract');
const { isPlainObject } = require('../is-plain-object');

const SCHEMA_VERSION = 'huqan-cognition-curiosity-v1';

// Design starting points frozen by
// docs/task-packs/cog-m10-curiosity-preregistration-20261030.md, not a
// measured-optimality claim.
const LP_WINDOW = 4;
const LP_SCALE = 2;
const LP_MIN = 0.02;
const EXPLORATION_BONUS = 0.1;
const NOISE_VARIANCE_MAX = 0.2;
const W_CURIOSITY = 0.5;
const W_CONFIDENCE = 0.5;

const OPTION_FIELDS = ['history', 'finalHoldoutSourceGroups'];
const text = (value) => typeof value === 'string' && value.trim() !== '';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const variance = (values) => {
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length;
};

/**
 * Validates raw history rows. A row without region/probeSetId/predictorVersion/
 * frameRef/at is a legacy record: it is kept out of every comparison rather
 * than guessed at. A row with a malformed known field is corrupt history and
 * ABSTAINs the whole call, because a silently repaired input would fake the
 * very evidence this module ranks on.
 */
function readHistory(history, holdoutSourceGroups) {
  if (history === undefined || history === null) return { status: COGNITION_STATUS.MEASURED, records: [] };
  if (!Array.isArray(history)) return { status: COGNITION_STATUS.ABSTAIN, reason: 'invalid_history' };
  const records = [];
  for (const row of history) {
    if (!isPlainObject(row) || !Array.isArray(row.errors)) return { status: COGNITION_STATUS.ABSTAIN, reason: 'invalid_history' };
    if (!row.errors.every(finite)) return { status: COGNITION_STATUS.ABSTAIN, reason: 'invalid_history' };
    if (row.errors.length === 0) continue;
    if (row.sourceGroup !== undefined && row.sourceGroup !== null && !text(row.sourceGroup)) {
      return { status: COGNITION_STATUS.ABSTAIN, reason: 'invalid_history' };
    }
    if (text(row.sourceGroup) && holdoutSourceGroups.includes(row.sourceGroup)) {
      return { status: COGNITION_STATUS.REJECT, reason: 'source_group_overlap' };
    }
    if (![row.region, row.probeSetId, row.predictorVersion, row.frameRef].every(text)) continue;
    if (row.at === undefined || row.at === null) continue;
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(at)) return { status: COGNITION_STATUS.ABSTAIN, reason: 'invalid_history' };
    records.push({
      region: row.region, probeSetId: row.probeSetId, predictorVersion: row.predictorVersion,
      frameRef: row.frameRef, at, errors: row.errors.slice(),
    });
  }
  return { status: COGNITION_STATUS.MEASURED, records };
}

const byMoment = (left, right) => left.at - right.at
  || left.predictorVersion.localeCompare(right.predictorVersion, 'en')
  || left.errors.join(',').localeCompare(right.errors.join(','), 'en');

/**
 * Picks the region's largest comparable group (same probeSetId + frameRef) and
 * takes the last two frozen windows of LP_WINDOW errors. The grouping is by
 * frozen probe set, so a monitoring set is never mixed with another one.
 */
function comparableWindows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.probeSetId}\u0000${row.frameRef}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let chosenKey = null;
  let chosen = [];
  for (const [key, list] of groups) {
    if (list.length > chosen.length || (list.length === chosen.length && (chosenKey === null || key < chosenKey))) {
      chosenKey = key;
      chosen = list;
    }
  }
  const ordered = chosen.slice().sort(byMoment);
  const flat = [];
  for (const row of ordered) for (const error of row.errors) flat.push({ error, version: row.predictorVersion });
  if (flat.length < 2 * LP_WINDOW) return { status: COGNITION_STATUS.INSUFFICIENT, reason: 'insufficient_comparable_windows', observations: rows.reduce((n, row) => n + row.errors.length, 0) };
  const recent = flat.slice(-2 * LP_WINDOW);
  const older = recent.slice(0, LP_WINDOW);
  const newer = recent.slice(LP_WINDOW);
  const olderVersions = [...new Set(older.map((entry) => entry.version))];
  const newerVersions = [...new Set(newer.map((entry) => entry.version))];
  if (olderVersions.length !== 1 || newerVersions.length !== 1) {
    return { status: COGNITION_STATUS.INSUFFICIENT, reason: 'mixed_predictor_window', observations: flat.length };
  }
  if (olderVersions[0] === newerVersions[0]) {
    return { status: COGNITION_STATUS.INSUFFICIENT, reason: 'predictor_unchanged', observations: flat.length };
  }
  const olderMean = mean(older.map((entry) => entry.error));
  const newerErrors = newer.map((entry) => entry.error);
  const learningProgress = round6(Math.max(0, olderMean - mean(newerErrors)));
  const spread = round6(variance(newerErrors));
  return {
    status: COGNITION_STATUS.MEASURED,
    reason: learningProgress === 0 ? 'no_learning_progress' : 'learning_progress_measured',
    learningProgress,
    variance: spread,
    noiseGuard: spread > NOISE_VARIANCE_MAX && learningProgress < LP_MIN,
    predictorVersions: [olderVersions[0], newerVersions[0]],
    probeSetId: chosen[0].probeSetId,
    frameRef: chosen[0].frameRef,
    observations: flat.length,
  };
}

const regionSummary = (records, region) => comparableWindows(records.filter((row) => row.region === region));

const DENIED_STATUS = Object.freeze({
  [COGNITION_STATUS.INSUFFICIENT]: COGNITION_STATUS.INSUFFICIENT,
  [COGNITION_STATUS.ABSTAIN]: COGNITION_STATUS.ABSTAIN,
  [COGNITION_STATUS.REJECT]: COGNITION_STATUS.REJECT,
});

function denied(summary, region) {
  return freezeResult({
    schemaVersion: SCHEMA_VERSION,
    status: DENIED_STATUS[summary.status] ?? COGNITION_STATUS.ABSTAIN,
    region,
    learningProgress: null,
    variance: null,
    noiseGuard: false,
    observations: summary.observations ?? 0,
    probeSetId: null,
    frameRef: null,
    predictorVersions: null,
    reason: summary.reason,
    authority: AUTHORITY.SIGNAL_ONLY,
  });
}

/**
 * @param {Array} history monitoring history rows from the #4071 data contract
 * @param {{region?: string}} options the region whose learning progress is asked
 * @returns {Readonly<object>} MEASURED, INSUFFICIENT, ABSTAIN or REJECT
 */
function learningProgress(history, options = {}) {
  const region = isPlainObject(options) ? options.region : null;
  if (!text(region)) return denied({ status: COGNITION_STATUS.REJECT, reason: 'invalid_region' }, null);
  const read = readHistory(history, []);
  if (read.status !== COGNITION_STATUS.MEASURED) return denied(read, region);
  const summary = regionSummary(read.records, region);
  if (summary.status !== COGNITION_STATUS.MEASURED) return denied(summary, region);
  return freezeResult({
    schemaVersion: SCHEMA_VERSION, status: summary.status, region,
    learningProgress: summary.learningProgress, variance: summary.variance,
    noiseGuard: summary.noiseGuard, observations: summary.observations,
    probeSetId: summary.probeSetId, frameRef: summary.frameRef,
    predictorVersions: summary.predictorVersions, reason: summary.reason,
    authority: AUTHORITY.SIGNAL_ONLY,
  });
}

function readOptions(options) {
  if (!isPlainObject(options)) return { reason: 'invalid_options' };
  if (Object.keys(options).some((key) => !OPTION_FIELDS.includes(key))) return { reason: 'invalid_options' };
  const groups = options.finalHoldoutSourceGroups ?? [];
  if (!Array.isArray(groups) || !groups.every(text)) return { reason: 'invalid_options' };
  return { history: options.history, holdoutSourceGroups: groups };
}

const regionOf = (hypothesis) => (text(hypothesis.region) ? hypothesis.region : text(hypothesis.relation) ? hypothesis.relation : null);

/**
 * Ranks normalized Dream hypotheses by curiosity. Order is score descending,
 * then key, so the result is independent of input order. A missing learning
 * progress is reported as INSUFFICIENT per candidate; the ranking still falls
 * back to exploration bonus plus uncalibrated confidence, which is an
 * exploration order and never a learning claim.
 */
function rankHypothesesByCuriosity(hypotheses, options = {}) {
  const finish = (status, reason, ranked = []) => freezeResult({
    schemaVersion: SCHEMA_VERSION, status, reason, ranked, authority: AUTHORITY.SIGNAL_ONLY,
  });
  const settings = readOptions(options);
  if (settings.reason) return finish(COGNITION_STATUS.REJECT, settings.reason);
  if (!Array.isArray(hypotheses)) return finish(COGNITION_STATUS.REJECT, 'invalid_hypotheses');
  const keys = new Set();
  for (const hypothesis of hypotheses) {
    if (!isPlainObject(hypothesis) || !text(hypothesis.key)) return finish(COGNITION_STATUS.REJECT, 'invalid_hypothesis');
    if (keys.has(hypothesis.key)) return finish(COGNITION_STATUS.REJECT, 'duplicate_key');
    keys.add(hypothesis.key);
  }
  const read = readHistory(settings.history, settings.holdoutSourceGroups);
  if (read.status === COGNITION_STATUS.REJECT || read.status === COGNITION_STATUS.ABSTAIN) {
    return finish(read.status, read.reason);
  }
  if (hypotheses.length === 0) return finish(COGNITION_STATUS.INSUFFICIENT, 'no_hypotheses');
  const ranked = hypotheses.map((hypothesis) => {
    const region = regionOf(hypothesis);
    const summary = region === null ? { status: COGNITION_STATUS.INSUFFICIENT, reason: 'no_region', observations: 0 } : regionSummary(read.records, region);
    const measured = summary.status === COGNITION_STATUS.MEASURED;
    const bonus = round6(EXPLORATION_BONUS / (1 + (summary.observations ?? 0)));
    const curiosity = summary.noiseGuard ? 0 : round6(clamp01(LP_SCALE * (measured ? summary.learningProgress : 0) + bonus));
    return {
      key: hypothesis.key, region,
      curiosity,
      learningProgress: measured ? summary.learningProgress : null,
      learningProgressStatus: measured ? COGNITION_STATUS.MEASURED : COGNITION_STATUS.INSUFFICIENT,
      explorationBonus: bonus,
      noiseGuard: Boolean(summary.noiseGuard),
      score: round6(W_CURIOSITY * curiosity + W_CONFIDENCE * clamp01(hypothesis.confidence)),
    };
  });
  ranked.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key, 'en'));
  const measured = ranked.some((row) => row.learningProgressStatus === COGNITION_STATUS.MEASURED);
  return finish(measured ? COGNITION_STATUS.MEASURED : COGNITION_STATUS.INSUFFICIENT,
    measured ? 'ranked_by_curiosity' : 'learning_progress_unmeasured', ranked);
}

module.exports = {
  SCHEMA_VERSION,
  LP_WINDOW,
  LP_SCALE,
  LP_MIN,
  EXPLORATION_BONUS,
  NOISE_VARIANCE_MAX,
  W_CURIOSITY,
  W_CONFIDENCE,
  learningProgress,
  rankHypothesesByCuriosity,
};
