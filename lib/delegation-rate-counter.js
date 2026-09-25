'use strict';

// #2505 implementation order, step 2 (second foundation): the delegation
// spawn clock counter. It records confirmed child starts with their time and
// answers how many fall inside the rolling windows the rate policy watches:
// 60 seconds per parent agent, one hour per workspace.
//
// Counting only, never judging: limits, equality rules and hold/block verdicts
// belong to the gate (and, for now, only to the replay script). A rejected or
// timed-out start is never recorded here at all -- the caller records only
// confirmed starts, so no slot is consumed by something that never ran.
//
// Time arrives explicitly (`at`) or falls back to the process clock. Tests
// pin windows with explicit times; production passes its ledger-service clock
// through the same parameter. Durability reuses the existing mutation journal
// authority like the sibling ledgers: no second table, and reopening the
// store resumes. Old rows outside every window are ignored, not deleted,
// consistent with the escape ledger.

const crypto = require('node:crypto');

const RATE_OPERATION_PREFIX = 'delegation-rate:';
const RATE_COUNTER_VERSION = 'huqan-delegation-rate-v1';
const PARENT_WINDOW_MS = 60 * 1000;
const WORKSPACE_WINDOW_MS = 60 * 60 * 1000;
const MAX_ID_FIELD_LENGTH = 256;

function text(value, field, { max = MAX_ID_FIELD_LENGTH } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  return normalized;
}

function instant(value, field) {
  const normalized = text(value, field);
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis)) throw new TypeError(`${field} must be a valid instant`);
  return new Date(millis).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function requireGraph(graph) {
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new TypeError('graph with runMutationOnce and prefix reads is required');
  }
  return graph;
}

function readRateRows(graph) {
  let rows = [];
  try {
    rows = graph.getCommittedMutationResultsByPrefix(RATE_OPERATION_PREFIX);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && row.result && row.result.rate === true);
}

/**
 * Record one confirmed child start.
 *
 * @returns {{startId, parentStarts60s, workspaceStartsHour}} the row id plus
 * the window counts as observed by this write (read-your-write, same call).
 */
function recordSpawnStart(graph, {
  policyVersion, workspaceId, parentAgentId, childId = null, at = null,
} = {}) {
  requireGraph(graph);
  const policy = text(policyVersion, 'policyVersion', { max: 64 });
  const workspace = text(workspaceId, 'workspaceId');
  const parent = text(parentAgentId, 'parentAgentId');
  const child = childId === undefined || childId === null ? null : text(childId, 'childId');
  const timestamp = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const startId = `start:${crypto.randomUUID()}`;
  graph.runMutationOnce(
    `${RATE_OPERATION_PREFIX}${startId}`,
    () => ({
      rate: true,
      counterVersion: RATE_COUNTER_VERSION,
      policyVersion: policy,
      workspaceId: workspace,
      parentAgentId: parent,
      childId: child,
      at: timestamp,
    }),
  );
  const rates = readSpawnRates(graph, {
    policyVersion: policy, workspaceId: workspace, parentAgentId: parent, at: timestamp,
  });
  return Object.freeze({ startId, parentStarts60s: rates.parentStarts60s, workspaceStartsHour: rates.workspaceStartsHour });
}

/**
 * Count confirmed starts inside the rolling windows as of `at`.
 */
function readSpawnRates(graph, {
  policyVersion, workspaceId, parentAgentId, at = null,
} = {}) {
  requireGraph(graph);
  const policy = text(policyVersion, 'policyVersion', { max: 64 });
  const workspace = text(workspaceId, 'workspaceId');
  const parent = text(parentAgentId, 'parentAgentId');
  const now = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const nowMs = Date.parse(now);
  let parentStarts60s = 0;
  let workspaceStartsHour = 0;
  for (const row of readRateRows(graph)) {
    const result = row.result;
    if (result.policyVersion !== policy || result.workspaceId !== workspace) continue;
    const atMs = Date.parse(typeof result.at === 'string' ? result.at : '');
    if (!Number.isFinite(atMs) || atMs > nowMs) continue;
    if (nowMs - atMs < WORKSPACE_WINDOW_MS) workspaceStartsHour += 1;
    if (result.parentAgentId === parent && nowMs - atMs < PARENT_WINDOW_MS) parentStarts60s += 1;
  }
  return Object.freeze({ parentStarts60s, workspaceStartsHour });
}

module.exports = {
  RATE_OPERATION_PREFIX,
  RATE_COUNTER_VERSION,
  PARENT_WINDOW_MS,
  WORKSPACE_WINDOW_MS,
  recordSpawnStart,
  readSpawnRates,
};
