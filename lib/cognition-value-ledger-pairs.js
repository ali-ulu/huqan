'use strict';

const { readPredictionPairs, PAIR_OPERATION_PREFIX, PAIR_STORE_VERSION } = require('./prediction-outcome-pairs');
const { buildValueLedger } = require('./cognition/value-ledger');
const { freezeResult } = require('./cognition/contract');

/** Read-only adapter. Legacy producer records have no workspace/source-group
 * binding: they remain insufficient until a producer supplies that evidence.
 * Journal committedAt, not a caller's backdated outcome.at, bounds availability.
 */
function readValueLedger(graph, options) {
  const empty = buildValueLedger([], options);
  if (empty.status === 'REJECT') return empty;
  const refuse = (status, reason) => freezeResult({ ...empty, status, reason });
  try {
    if (!graph || typeof graph.getCommittedMutationResultsByPrefix !== 'function') return refuse('INSUFFICIENT', 'journal_unavailable');
    const rows = graph.getCommittedMutationResultsByPrefix(PAIR_OPERATION_PREFIX);
    if (!Array.isArray(rows)) return refuse('INSUFFICIENT', 'journal_unavailable');
    const selected = [];
    const byPart = new Map();
    let unscoped = false;
    for (const row of rows) {
      const result = row && row.result;
      if (!result || result.predictionPair !== true) continue;
      if (typeof result.workspaceId !== 'string' || !result.workspaceId.trim()) { unscoped = true; continue; }
      if (result.workspaceId !== options.workspaceId) continue;
      if (result.decisionId === options.historyBoundary.decisionId) continue;
      if (typeof row.committedAt !== 'string' || !Number.isFinite(Date.parse(row.committedAt))) return refuse('INSUFFICIENT', 'source_availability_unknown');
      if (Date.parse(row.committedAt) >= Math.min(Date.parse(options.asOf), Date.parse(options.historyBoundary.at))) continue;
      if (result.storeVersion !== PAIR_STORE_VERSION) return refuse('INSUFFICIENT', 'unsupported_source_version');
      const kind = result.prediction ? 'prediction' : 'outcome';
      if (!result[kind] || (result.prediction && result.outcome) || typeof result.decisionId !== 'string') return refuse('REJECT', 'invalid_pair');
      const key = JSON.stringify([result.decisionId, kind]);
      const prior = byPart.get(key);
      if (prior) {
        if (JSON.stringify(prior.result) !== JSON.stringify(result)) return refuse('REJECT', 'conflicting_duplicate');
        continue;
      }
      byPart.set(key, row);
      selected.push(row);
    }
    // Reuse the existing pairing rules over the already-read, scope/time-limited snapshot.
    const pairs = readPredictionPairs({
      runMutationOnce() { throw new Error('read-only journal snapshot'); },
      getCommittedMutationResultsByPrefix() { return selected; },
    });
    const rewards = [];
    for (const pair of Object.values(pairs)) {
      if (!pair.outcome) continue;
      const prediction = byPart.get(JSON.stringify([pair.decisionId, 'prediction']));
      const outcome = byPart.get(JSON.stringify([pair.decisionId, 'outcome']));
      const actionClass = pair.prediction.actionClass;
      if (!Number.isFinite(Date.parse(pair.prediction.at)) || !Number.isFinite(Date.parse(pair.outcome.at))
        || Date.parse(pair.prediction.at) > Date.parse(pair.outcome.at)
        || Date.parse(prediction.committedAt) > Date.parse(outcome.committedAt)
        || (actionClass !== null && actionClass !== undefined && typeof actionClass !== 'string')) return refuse('REJECT', 'invalid_pair_order');
      rewards.push({
        workspaceId: options.workspaceId, key: `risk:${actionClass || 'unclassified'}`,
        decisionId: pair.decisionId, at: pair.outcome.at, availableAt: outcome.committedAt,
        outcome: pair.outcome.state, sourceGroup: outcome.result.sourceGroup,
        sourceRefs: outcome.result.sourceRefs,
      });
    }
    const ledger = buildValueLedger(rewards, options);
    return unscoped && ledger.entries.length === 0 && ledger.status !== 'REJECT'
      ? freezeResult({ ...ledger, reason: 'source_scope_missing' }) : ledger;
  } catch (_) {
    return refuse('INSUFFICIENT', 'journal_unavailable');
  }
}

module.exports = { readValueLedger };
