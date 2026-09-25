'use strict';

// #2505 implementation order, step 2 (last foundation): cross-session bypass
// signal state. It stores who tried to go around a constraint -- a repeated
// verified refusal fingerprint, a sandbox escape attempt, an identity
// widening, or an unexpected egress -- keyed by agent identity plus
// workspace inside a bounded 24-hour window.
//
// Evidence only, never a response: counting a second identical attempt is
// this module's whole job; review, block and emergency-stop proposals belong
// to the gate, which also owns their thresholds. Absent identity is unknown
// and cannot be treated as a clean history, so rows without an agent land
// under an explicitly unattributed bucket instead of polluting anyone's
// count. Store only digest, count, time and receipt reference: raw tool
// arguments never reach this store.
//
// Durability reuses the existing mutation journal authority like the sibling
// ledgers; reopening the store resumes. Old rows outside every window are
// ignored, not deleted, consistent with the escape ledger.

const crypto = require('node:crypto');

const BYPASS_OPERATION_PREFIX = 'bypass-signal:';
const BYPASS_STATE_VERSION = 'huqan-bypass-state-v1';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ID_FIELD_LENGTH = 256;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;

const BYPASS_KINDS = Object.freeze([
  'refused-retry',
  'sandbox-escape',
  'identity-widening',
  'unexpected-egress',
]);

function text(value, field, { max = MAX_ID_FIELD_LENGTH } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  if (normalized.includes('\0')) throw new TypeError(`${field} must not contain null characters`);
  return normalized;
}

function maybeText(value, field, options) {
  if (value === undefined || value === null) return null;
  const normalized = text(value, field, options);
  return normalized || null;
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

function fingerprint(value) {
  const normalized = text(value, 'fingerprint', { max: 128 });
  if (!FINGERPRINT_PATTERN.test(normalized)) {
    throw new TypeError('fingerprint must be a hex digest so raw arguments never reach this store');
  }
  return normalized.toLowerCase();
}

function requireGraph(graph) {
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new TypeError('graph with runMutationOnce and prefix reads is required');
  }
  return graph;
}

function readBypassRows(graph) {
  let rows = [];
  try {
    rows = graph.getCommittedMutationResultsByPrefix(BYPASS_OPERATION_PREFIX);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && row.result && row.result.bypass === true);
}

/**
 * Record one bypass signal.
 */
function recordBypassSignal(graph, {
  kind, workspaceId, agentId = null, fingerprint: digest, receiptRef = null, at = null,
} = {}) {
  requireGraph(graph);
  if (!BYPASS_KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of ${BYPASS_KINDS.join(', ')}`);
  }
  const workspace = text(workspaceId, 'workspaceId');
  const agent = maybeText(agentId, 'agentId');
  const print = fingerprint(digest);
  const ref = maybeText(receiptRef, 'receiptRef', { max: 512 });
  const timestamp = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const signalId = `signal:${crypto.randomUUID()}`;
  graph.runMutationOnce(
    `${BYPASS_OPERATION_PREFIX}${signalId}`,
    () => ({
      bypass: true,
      stateVersion: BYPASS_STATE_VERSION,
      kind,
      workspaceId: workspace,
      agentId: agent,
      fingerprint: print,
      receiptRef: ref,
      at: timestamp,
    }),
  );
  return Object.freeze({ signalId });
}

/**
 * Count signals inside the window ending at `at`, grouped by fingerprint.
 * Agent-scoped by default; pass no agentId for the workspace total (which
 * keeps unattributed rows visible instead of hiding them).
 */
function readBypassState(graph, {
  workspaceId, agentId = null, kind = null, windowMs = DEFAULT_WINDOW_MS, at = null,
} = {}) {
  requireGraph(graph);
  const workspace = text(workspaceId, 'workspaceId');
  const agent = agentId === undefined || agentId === null ? null : text(agentId, 'agentId');
  if (kind !== undefined && kind !== null && !BYPASS_KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of ${BYPASS_KINDS.join(', ')}`);
  }
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('windowMs must be a positive finite number');
  }
  const now = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const nowMs = Date.parse(now);
  const byFingerprint = {};
  let total = 0;
  for (const row of readBypassRows(graph)) {
    const result = row.result;
    if (result.workspaceId !== workspace) continue;
    if (agent !== null && result.agentId !== agent) continue;
    if (kind !== undefined && kind !== null && result.kind !== kind) continue;
    const atMs = Date.parse(typeof result.at === 'string' ? result.at : '');
    if (!Number.isFinite(atMs) || atMs > nowMs || nowMs - atMs >= windowMs) continue;
    if (typeof result.fingerprint !== 'string') continue;
    total += 1;
    const entry = byFingerprint[result.fingerprint] || { count: 0, kinds: [], lastAt: null };
    entry.count += 1;
    if (!entry.kinds.includes(result.kind)) entry.kinds.push(result.kind);
    if (entry.lastAt === null || result.at > entry.lastAt) entry.lastAt = result.at;
    byFingerprint[result.fingerprint] = entry;
  }
  const fingerprints = {};
  for (const [print, entry] of Object.entries(byFingerprint)) {
    fingerprints[print] = Object.freeze({ ...entry, kinds: Object.freeze(entry.kinds) });
  }
  return Object.freeze({ workspaceId: workspace, agentId: agent, windowMs, at: now, total, byFingerprint: Object.freeze(fingerprints) });
}

module.exports = {
  BYPASS_OPERATION_PREFIX,
  BYPASS_STATE_VERSION,
  BYPASS_KINDS,
  DEFAULT_WINDOW_MS,
  recordBypassSignal,
  readBypassState,
};
