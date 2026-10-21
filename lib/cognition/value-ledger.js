'use strict';

const { AUTHORITY, round6, freezeResult } = require('./contract');
const { rewardForOutcome, RPE_BOUND } = require('./reward-signal');
const { isPlainObject } = require('../is-plain-object');

const SCHEMA_VERSION = 'huqan-cognition-value-ledger-v1';
const ALPHA_MIN = 0.05;
const AROUSAL_BETA = 0.3;
const CONFIDENCE_K = 4;
const MIN_SAMPLES = 3;
const VALENCE_BAND = 0.1;
const MAX_EVENTS = 5000;
const FIELDS = ['workspaceId', 'key', 'decisionId', 'at', 'availableAt', 'outcome', 'sourceGroup', 'sourceRefs'];
const text = (value) => typeof value === 'string' && value.trim() !== '' && value === value.trim();
const time = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compare = (a, b) => Date.parse(a.at) - Date.parse(b.at) || compareText(a.decisionId, b.decisionId);

// Explicit source groups and overlapping source refs form connected evidence groups.
function independentCount(events, dependencyEvents) {
  const parents = new Map();
  const root = (token) => {
    if (!parents.has(token)) parents.set(token, token);
    let current = token;
    while (parents.get(current) !== current) current = parents.get(current);
    while (token !== current) {
      const next = parents.get(token);
      parents.set(token, current);
      token = next;
    }
    return current;
  };
  // Retention limits the reward fold, not already-known evidence dependencies.
  for (const event of dependencyEvents) {
    if (event.sourceRefs.length === 0) continue;
    const group = event.sourceGroup ? `group:${event.sourceGroup}` : `ref:${event.sourceRefs[0]}`;
    for (const ref of event.sourceRefs) parents.set(root(`ref:${ref}`), root(group));
  }
  const groups = events.filter((event) => event.sourceGroup && event.sourceRefs.length > 0 && rewardForOutcome(event.outcome) !== null)
    .map((event) => root(`group:${event.sourceGroup}`));
  return new Set(groups).size;
}

function fold(key, events, historyBoundary, dependencyEvents) {
  const observed = events.filter((event) => rewardForOutcome(event.outcome) !== null);
  let value = 0;
  let arousal = 0;
  let nConfirmed = 0;
  for (const [index, event] of observed.entries()) {
    const rpe = rewardForOutcome(event.outcome) - value;
    value += Math.max(ALPHA_MIN, 1 / (index + 1)) * rpe;
    arousal = (1 - AROUSAL_BETA) * arousal + AROUSAL_BETA * Math.abs(rpe) / RPE_BOUND;
    if (event.outcome === 'confirmed') nConfirmed++;
  }
  const nObserved = observed.length;
  const nIndependent = independentCount(events, dependencyEvents);
  const measured = nIndependent >= MIN_SAMPLES;
  const p = round6((nConfirmed + 1) / (nObserved + 2));
  return {
    key, status: measured ? 'MEASURED' : 'INSUFFICIENT', nObserved, nIndependent,
    value: measured ? round6(value) : null,
    valence: measured ? (value > VALENCE_BAND ? 'positive' : value < -VALENCE_BAND ? 'negative' : 'neutral') : null,
    arousal: measured ? round6(arousal) : null,
    supportScore: round6(nIndependent / (nIndependent + CONFIDENCE_K)),
    success: { target: 'confirmed', nConfirmed, nObserved, p: measured ? p : null, status: measured ? 'MEASURED' : 'INSUFFICIENT', calibration: 'NOT_MEASURED' },
    provisional: measured ? null : { value: round6(value), p, reason: 'insufficient_independent_support' },
    sourceRefs: [...new Set(events.flatMap((event) => event.sourceRefs))].sort(),
    historyBoundary, lastAt: observed[nObserved - 1].at,
  };
}

/** Read model only. Each outcome carries its observation time AND availability time.
 * asOf and the (at, decisionId) historyBoundary are exclusive decision boundaries.
 * Missing source groups remain unknown; journal row IDs are not independent sources.
 */
function buildValueLedger(rewards, options = {}) {
  const finish = (status, reason, entries = [], truncated = false, scope = {}) => freezeResult({
    schemaVersion: SCHEMA_VERSION, status, reason, authority: AUTHORITY.SIGNAL_ONLY,
    workspaceId: scope.workspaceId || null, asOf: scope.asOf || null,
    historyBoundary: scope.historyBoundary || null, entries, truncated,
  });
  if (!Array.isArray(rewards) || !isPlainObject(options)) return finish('REJECT', 'invalid_input');
  const { workspaceId, asOf, historyBoundary } = options;
  if (Object.keys(options).some((key) => !['workspaceId', 'asOf', 'historyBoundary'].includes(key))
    || !text(workspaceId) || !time(asOf) || !isPlainObject(historyBoundary)
    || Object.keys(historyBoundary).some((key) => !['at', 'decisionId'].includes(key))
    || !time(historyBoundary.at) || !text(historyBoundary.decisionId)
    || Date.parse(historyBoundary.at) > Date.parse(asOf)) return finish('REJECT', 'invalid_history_boundary');
  const scope = { workspaceId, asOf: new Date(asOf).toISOString(), historyBoundary: { at: new Date(historyBoundary.at).toISOString(), decisionId: historyBoundary.decisionId } };
  const reject = (reason) => finish('REJECT', reason, [], false, scope);
  const decisions = new Map();
  for (const record of rewards) {
    if (!isPlainObject(record) || !text(record.workspaceId)) return reject('invalid_record');
    if (record.workspaceId !== workspaceId) continue;
    if (record.decisionId === historyBoundary.decisionId) continue;
    if (!time(record.at) || !time(record.availableAt) || Date.parse(record.availableAt) < Date.parse(record.at)) return reject('invalid_record');
    if (Date.parse(record.availableAt) >= Math.min(Date.parse(asOf), Date.parse(historyBoundary.at))) continue;
    if (Object.keys(record).some((key) => !FIELDS.includes(key)) || !text(record.key) || !text(record.decisionId)
      || (record.sourceGroup !== null && record.sourceGroup !== undefined && !text(record.sourceGroup))
      || (record.sourceRefs !== undefined && (!Array.isArray(record.sourceRefs) || !record.sourceRefs.every(text)))) return reject('invalid_record');
    if (compare(record, historyBoundary) >= 0) continue;
    const normalized = {
      workspaceId, key: record.key, decisionId: record.decisionId,
      at: new Date(record.at).toISOString(), availableAt: new Date(record.availableAt).toISOString(),
      outcome: record.outcome === undefined ? null : record.outcome,
      sourceGroup: record.sourceGroup || null, sourceRefs: [...new Set(record.sourceRefs || [])].sort(),
    };
    const prior = decisions.get(record.decisionId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) return reject('conflicting_duplicate');
    decisions.set(record.decisionId, normalized);
  }
  const history = [...decisions.values()].sort(compare);
  const truncated = history.length > MAX_EVENTS;
  const dependencies = new Map();
  for (const event of history) {
    if (!dependencies.has(event.key)) dependencies.set(event.key, []);
    dependencies.get(event.key).push(event);
  }
  const groups = new Map();
  for (const event of history.slice(-MAX_EVENTS)) {
    if (!groups.has(event.key)) groups.set(event.key, []);
    groups.get(event.key).push(event);
  }
  const entries = [...groups].filter(([, events]) => events.some((event) => rewardForOutcome(event.outcome) !== null))
    .sort(([a], [b]) => compareText(a, b)).map(([key, events]) => fold(key, events, scope.historyBoundary, dependencies.get(key)));
  const measured = entries.some((entry) => entry.status === 'MEASURED');
  return finish(measured ? 'MEASURED' : 'INSUFFICIENT', measured ? 'observed_history' : 'insufficient_independent_support', entries, truncated, scope);
}

function expectedFor(ledger, key) {
  if (!ledger || ledger.schemaVersion !== SCHEMA_VERSION || ledger.status === 'REJECT' || !Array.isArray(ledger.entries)) return null;
  const entry = ledger.entries.find((row) => row.key === key);
  return entry && entry.status === 'MEASURED' ? entry.value : null;
}

module.exports = { SCHEMA_VERSION, ALPHA_MIN, AROUSAL_BETA, CONFIDENCE_K, MIN_SAMPLES, VALENCE_BAND, MAX_EVENTS, buildValueLedger, expectedFor };
