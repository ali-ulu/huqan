'use strict';

// #2505 implementation order, step 2 (third foundation): financial payment
// aggregation. It parses exact decimal amounts and sums assessed payments by
// destination, task and 24-hour window, so split payments cannot avoid a
// limit later.
//
// Amounts never touch floating point: strings keep their digits with an
// explicit scale, and non-integer numbers are refused outright (their exact
// value is already unrecoverable). Sums align on the widest scale in the
// group with BigInt, so `0.1 + 0.2` is `0.3`, never `0.30000000000000004`.
//
// Aggregation only, never limits: owner-signed per-currency limit tables and
// the review/quorum/block verdicts belong to the gate (and, for now, only to
// the replay script). Currency codes are format-checked (ISO alpha-3 shape),
// never allowlisted -- other currencies stay usable here and held for review
// by policy. Durability reuses the existing mutation journal authority like
// the sibling ledgers; reopening the store resumes. Duplicate idempotency
// keys replay the prior row instead of double-counting the sum.

const crypto = require('node:crypto');

const AGGREGATION_OPERATION_PREFIX = 'financial-aggregation:';
const FINANCIAL_AGGREGATION_VERSION = 'huqan-financial-aggregation-v1';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_AMOUNT_INTEGER_DIGITS = 24;
const MAX_AMOUNT_FRACTION_DIGITS = 8;
const MAX_ID_FIELD_LENGTH = 256;

function text(value, field, { max = MAX_ID_FIELD_LENGTH } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  // The '\0unscoped' sentinel below must stay unforgeable.
  if (normalized.includes('\0')) throw new TypeError(`${field} must not contain null characters`);
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

/**
 * Parse an exact positive decimal amount without floating point.
 * Accepts digit strings (`"10"`, `"10.50"`) and integer numbers; a
 * non-integer number is refused because its exact value no longer exists.
 * @returns {{units: string, scale: number}} integer digits with decimal scale
 */
function parseDecimalAmount(raw) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw <= 0) return null;
    return { units: String(raw), scale: 0 };
  }
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return null;
  const integers = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] || '').slice(0, MAX_AMOUNT_FRACTION_DIGITS);
  if (integers.length > MAX_AMOUNT_INTEGER_DIGITS) return null;
  if (match[2] !== undefined && match[2].length > MAX_AMOUNT_FRACTION_DIGITS) return null;
  const units = `${integers}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  if (units === '0') return null;
  return { units, scale: fraction.length };
}

function currencyCode(value) {
  const normalized = text(value, 'currency', { max: 8 }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new TypeError('currency must be a 3-letter ISO code shape');
  return normalized;
}

/** Sum exact amounts, aligning on the widest scale in the group. */
function sumAmounts(amounts) {
  const list = Array.isArray(amounts) ? amounts : [];
  let scale = 0;
  const parsed = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') throw new TypeError('amounts must be parsed decimal amounts');
    if (typeof entry.units !== 'string' || !/^\d+$/.test(entry.units)
      || !Number.isInteger(entry.scale) || entry.scale < 0) {
      throw new TypeError('amounts must be parsed decimal amounts');
    }
    scale = Math.max(scale, entry.scale);
    parsed.push(entry);
  }
  let total = 0n;
  for (const entry of parsed) {
    total += BigInt(entry.units) * 10n ** BigInt(scale - entry.scale);
  }
  return { units: total.toString(), scale };
}

function requireGraph(graph) {
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new TypeError('graph with runMutationOnce and prefix reads is required');
  }
  return graph;
}

function readPaymentRows(graph) {
  let rows = [];
  try {
    rows = graph.getCommittedMutationResultsByPrefix(AGGREGATION_OPERATION_PREFIX);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && row.result && row.result.payment === true);
}

function normalizeScope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('scope must be an object');
  }
  return Object.freeze({
    policyVersion: text(input.policyVersion, 'scope.policyVersion', { max: 64 }),
    workspaceId: text(input.workspaceId, 'scope.workspaceId'),
    taskId: input.taskId === undefined || input.taskId === null ? null : text(input.taskId, 'scope.taskId'),
  });
}

/**
 * Record one assessed payment. The same idempotency key replays the prior
 * row instead of adding to the sum, so a retried assessment cannot inflate
 * a destination or task total.
 */
function recordPayment(graph, {
  scope, destination, currency, amount, idempotencyKey, at = null,
} = {}) {
  requireGraph(graph);
  const settled = normalizeScope(scope);
  const dest = text(destination, 'destination');
  const code = currencyCode(currency);
  const parsed = parseDecimalAmount(amount);
  if (!parsed) throw new TypeError('amount must be an exact positive decimal');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.trim().length > 128) {
    throw new TypeError('idempotencyKey is required');
  }
  const keyId = idempotencyKey.trim();
  const timestamp = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const outcome = graph.runMutationOnce(
    `${AGGREGATION_OPERATION_PREFIX}${keyId}`,
    () => ({
      payment: true,
      aggregationVersion: FINANCIAL_AGGREGATION_VERSION,
      scope: settled,
      destination: dest,
      currency: code,
      amount: parsed,
      at: timestamp,
    }),
  );
  return Object.freeze({ replayed: Boolean(outcome.replayed), paymentId: `payment:${keyId}` });
}

/**
 * Sum recorded payments by destination and by task inside the window ending
 * at `at`. Totals group per currency; each total carries its scale so no
 * precision is lost in transport.
 */
function readPaymentTotals(graph, { scope, windowMs = DEFAULT_WINDOW_MS, at = null } = {}) {
  requireGraph(graph);
  const settled = normalizeScope(scope);
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('windowMs must be a positive finite number');
  }
  const now = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const nowMs = Date.parse(now);
  const byDestination = {};
  const byTask = {};
  const add = (bucket, group, entry) => {
    const groupKey = group === null ? '\0unscoped' : group;
    bucket[groupKey] = bucket[groupKey] || {};
    bucket[groupKey][entry.currency] = bucket[groupKey][entry.currency] || [];
    bucket[groupKey][entry.currency].push(entry.amount);
  };
  for (const row of readPaymentRows(graph)) {
    const result = row.result;
    let rowScope = null;
    try {
      rowScope = normalizeScope(result.scope);
    } catch (_) {
      continue;
    }
    if (rowScope.policyVersion !== settled.policyVersion || rowScope.workspaceId !== settled.workspaceId) continue;
    if (settled.taskId !== null && rowScope.taskId !== settled.taskId) continue;
    const atMs = Date.parse(typeof result.at === 'string' ? result.at : '');
    if (!Number.isFinite(atMs) || atMs > nowMs || nowMs - atMs >= windowMs) continue;
    if (!result.currency || !result.amount) continue;
    add(byDestination, result.destination, result);
    add(byTask, result.scope.taskId, result);
  }
  const totalize = (bucket) => {
    const out = {};
    for (const [group, currencies] of Object.entries(bucket)) {
      out[group === '\0unscoped' ? 'unscoped' : group] = {};
      for (const [code, amounts] of Object.entries(currencies)) {
        out[group === '\0unscoped' ? 'unscoped' : group][code] = sumAmounts(amounts);
      }
    }
    return Object.freeze(out);
  };
  return Object.freeze({
    scope: settled,
    windowMs,
    at: now,
    byDestination: totalize(byDestination),
    byTask: totalize(byTask),
  });
}

module.exports = {
  AGGREGATION_OPERATION_PREFIX,
  FINANCIAL_AGGREGATION_VERSION,
  DEFAULT_WINDOW_MS,
  parseDecimalAmount,
  sumAmounts,
  recordPayment,
  readPaymentTotals,
};
