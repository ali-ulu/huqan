'use strict';

/**
 * COG-B (#4392 PR-3): durable repair-closure records.
 *
 * A repair closes one named prior decision. The closure is an append-only
 * journal operation under its own prefix, so it survives restart without
 * changing the prediction/outcome pair schema. Only a confirmed, independently
 * verified closure is recorded; malformed or foreign rows are ignored by the
 * reader and never repaired. Pure Core ring: no I/O, no clock beyond the
 * caller-provided instant.
 */

const { isPlainObject } = require('./is-plain-object');

const REPAIR_OPERATION_PREFIX = 'cognition-repair:';
const REPAIR_STORE_VERSION = 'huqan-cognition-repair-v1';
const REPAIR_OUTCOMES = Object.freeze(['confirmed', 'contradiction']);
const MAX_FIELD_LENGTH = 256;

const text = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > MAX_FIELD_LENGTH) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
};
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = (value, field) => {
  const normalized = text(value, field);
  const millis = ZONED_TIMESTAMP.test(normalized) ? Date.parse(normalized) : NaN;
  if (!Number.isFinite(millis)) throw new TypeError(`${field} must be a valid instant`);
  return new Date(millis).toISOString();
};

function requireGraph(graph) {
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new TypeError('graph with runMutationOnce and prefix reads is required');
  }
  return graph;
}

function readRepairRows(graph) {
  let rows = [];
  try {
    rows = graph.getCommittedMutationResultsByPrefix(REPAIR_OPERATION_PREFIX);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && isPlainObject(row.result)
    && row.result.repairClosure === true && row.result.storeVersion === REPAIR_STORE_VERSION);
}

/**
 * Append one confirmed repair closure. The same repairId replays its record;
 * a different target for the same repairId fails closed.
 *
 * @param {object} graph
 * @param {{ repairId: string, targetDecisionId: string, workspaceId: string,
 *   executorRef: string, verifierRef: string, outcome: 'confirmed'|'contradiction',
 *   at?: string }} input
 */
function recordRepairClosure(graph, {
  repairId, targetDecisionId, workspaceId, executorRef, verifierRef, outcome, at = null,
} = {}) {
  requireGraph(graph);
  const id = text(repairId, 'repairId');
  const target = text(targetDecisionId, 'targetDecisionId');
  const workspace = text(workspaceId, 'workspaceId');
  const executor = text(executorRef, 'executorRef');
  const verifier = text(verifierRef, 'verifierRef');
  if (executor === verifier) throw new TypeError('verifier must differ from executor');
  if (!REPAIR_OUTCOMES.includes(outcome)) throw new TypeError(`outcome must be one of ${REPAIR_OUTCOMES.join(', ')}`);
  if (outcome !== 'confirmed') throw new TypeError('only a confirmed repair closure is recorded');
  const timestamp = at === undefined || at === null ? new Date().toISOString() : instant(at, 'at');
  const operationId = `${REPAIR_OPERATION_PREFIX}closure:${id}`;
  const prior = readRepairRows(graph).find((row) => row.operationId === operationId);
  if (prior) {
    const same = prior.result.targetDecisionId === target && prior.result.workspaceId === workspace
      && prior.result.outcome?.state === outcome;
    if (!same) throw new Error('repair closure conflict');
    return Object.freeze({ replayed: true, repairId: id, targetDecisionId: target, outcome });
  }
  const written = graph.runMutationOnce(operationId, () => ({
    repairClosure: true,
    storeVersion: REPAIR_STORE_VERSION,
    workspaceId: workspace,
    repairId: id,
    targetDecisionId: target,
    executorRef: executor,
    verifierRef: verifier,
    outcome: Object.freeze({ state: outcome, at: timestamp }),
  }));
  return Object.freeze({ replayed: Boolean(written.replayed), repairId: id, targetDecisionId: target, outcome });
}

/** All well-formed closures, oldest first; malformed rows are ignored. */
function readRepairClosures(graph) {
  requireGraph(graph);
  return Object.freeze(readRepairRows(graph).map((row) => Object.freeze({
    repairId: row.result.repairId,
    targetDecisionId: row.result.targetDecisionId,
    workspaceId: row.result.workspaceId,
    executorRef: row.result.executorRef,
    verifierRef: row.result.verifierRef,
    outcome: row.result.outcome?.state ?? null,
    at: row.result.outcome?.at ?? null,
  })).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.repairId < b.repairId ? -1 : 1))));
}

/** Confirmed closures for one target decision. */
function closuresForTarget(graph, targetDecisionId) {
  const target = text(targetDecisionId, 'targetDecisionId');
  return Object.freeze(readRepairClosures(graph).filter((event) =>
    event.targetDecisionId === target && event.outcome === 'confirmed'));
}

module.exports = {
  REPAIR_OPERATION_PREFIX, REPAIR_STORE_VERSION, REPAIR_OUTCOMES,
  recordRepairClosure, readRepairClosures, closuresForTarget,
};
