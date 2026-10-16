'use strict';

const { factKey } = require('./inference-semi-naive-values');
const {
  DERIVED_RECORD_SCHEMA_VERSION,
  DERIVED_STATES,
  transitionDerivedRecord,
  derivedStateAt,
  canBackTrustReceipt,
} = require('./inference-derived-record');

function recordTokens(record) {
  const tokens = new Set([
    record.derivationId,
    `derivation:${record.derivationId}`,
    record.factKey,
    `fact:${record.factKey}`,
  ]);
  for (const ref of record.transitiveProvenanceRefs || []) {
    tokens.add(ref);
    tokens.add(`provenance:${ref}`);
  }
  for (const ref of record.transitiveSourceRefs || []) {
    tokens.add(ref);
    tokens.add(`source:${ref}`);
  }
  return tokens;
}

function supportTokens(record) {
  const tokens = new Set();
  for (const support of record.supports || []) {
    tokens.add(support.factKey);
    tokens.add(`fact:${support.factKey}`);
    if (support.derivedRecordId) {
      tokens.add(support.derivedRecordId);
      tokens.add(`derivation:${support.derivedRecordId}`);
    }
    for (const ref of support.provenanceRefs || []) {
      tokens.add(ref);
      tokens.add(`provenance:${ref}`);
    }
    for (const ref of support.transitiveProvenanceRefs || []) {
      tokens.add(ref);
      tokens.add(`provenance:${ref}`);
    }
    for (const ref of support.sourceRefs || []) {
      tokens.add(ref);
      tokens.add(`source:${ref}`);
    }
    for (const ref of support.transitiveSourceRefs || []) {
      tokens.add(ref);
      tokens.add(`source:${ref}`);
    }
  }
  return tokens;
}

function normalizeSupportReference(input) {
  const tokens = new Set();
  if (typeof input === 'string' && input.trim()) {
    tokens.add(input.trim());
    return tokens;
  }
  if (!input || typeof input !== 'object') {
    throw new TypeError('support reference must be a string or object');
  }
  if (input.fact) {
    const key = factKey(input.fact);
    tokens.add(key);
    tokens.add(`fact:${key}`);
  }
  for (const [field, prefix] of [
    ['derivationId', 'derivation'],
    ['provenanceId', 'provenance'],
    ['sourceRef', 'source'],
  ]) {
    if (typeof input[field] === 'string' && input[field].trim()) {
      const value = input[field].trim();
      tokens.add(value);
      tokens.add(`${prefix}:${value}`);
    }
  }
  if (tokens.size === 0) throw new TypeError('support reference contains no identity');
  return tokens;
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const byId = new Map();
  for (const record of records) {
    if (!record || record.schemaVersion !== DERIVED_RECORD_SCHEMA_VERSION) {
      throw new TypeError('records must contain only derived records');
    }
    byId.set(record.derivationId, record);
  }
  return byId;
}

function hasIntersection(left, right) {
  for (const item of left) if (right.has(item)) return true;
  return false;
}

function findDependents(records, supportReference) {
  const byId = normalizeRecords(records);
  const target = normalizeSupportReference(supportReference);
  return [...byId.values()]
    .filter((record) => hasIntersection(supportTokens(record), target))
    .sort((left, right) => left.derivationId.localeCompare(right.derivationId));
}

function withdrawDependents(records, supportReference, opts = {}) {
  const byId = normalizeRecords(records);
  const initialTokens = normalizeSupportReference(supportReference);
  const queue = [initialTokens];
  const seenTokenSets = new Set();
  const affected = [];
  const at = opts.at;
  const reason = typeof opts.reason === 'string' && opts.reason.trim()
    ? opts.reason.trim()
    : 'support_withdrawn';

  while (queue.length > 0) {
    const target = queue.shift();
    const targetKey = [...target].sort().join('|');
    if (seenTokenSets.has(targetKey)) continue;
    seenTokenSets.add(targetKey);

    for (const [id, record] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (
        record.state === DERIVED_STATES.CONTRADICTED
        || record.state === DERIVED_STATES.WITHDRAWN
        || record.state === DERIVED_STATES.SUPERSEDED
      ) {
        continue;
      }
      if (!hasIntersection(supportTokens(record), target)) continue;

      const matchedToken = [...supportTokens(record)]
        .sort()
        .find((token) => target.has(token)) || '';
      const next = transitionDerivedRecord(record, DERIVED_STATES.WITHDRAWN, {
        at,
        reason,
        supportRef: matchedToken,
      });
      byId.set(id, next);
      affected.push(id);
      queue.push(recordTokens(next));
    }
  }

  const nextRecords = [...byId.values()]
    .sort((left, right) => left.derivationId.localeCompare(right.derivationId));

  return Object.freeze({
    records: Object.freeze(nextRecords),
    affectedDerivationIds: Object.freeze([...new Set(affected)].sort()),
    reevaluateDerivationIds: Object.freeze([...new Set(affected)].sort()),
  });
}

function trustReceiptStatusAt(record, receiptId, asOf) {
  const state = derivedStateAt(record, asOf);
  if (!state) {
    return Object.freeze({
      valid: false,
      reason: 'derivation_not_yet_present',
      state: null,
    });
  }
  const valid = state.state === DERIVED_STATES.ADMITTED
    && state.receiptId === receiptId;
  return Object.freeze({
    valid,
    reason: valid ? 'admitted_at_time' : `derived_state_${state.state}`,
    state,
  });
}

function currentTrustReceiptStatus(record, receiptId) {
  const valid = canBackTrustReceipt(record, receiptId);
  return Object.freeze({
    valid,
    reason: valid ? 'currently_admitted' : `derived_state_${record.state}`,
    state: record.state,
    receiptId: record.trustReceiptId,
  });
}

module.exports = {
  findDependents,
  withdrawDependents,
  trustReceiptStatusAt,
  currentTrustReceiptStatus,
};
