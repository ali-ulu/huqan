'use strict';

/**
 * RECEIPT-TRUST-ROOT-3 - V4-family classification, version-aware chain
 * validation, and the durable-write guard (ADR-008/ADR-009).
 *
 * Generic hash/link chain validation (./receipt-chain.js) remains unchanged
 * and is not narrowed to V4 schemas. This module adds a V4-scoped layer on
 * top of it: exact per-record shape validation for each supported V4 schema
 * version, chronological version-ordering, and a durable-write guard that
 * fails closed for any V2-or-later V4 write until a later gate names an
 * authoritative trust-root owner.
 */

const { CANONICAL_RECEIPT_SCHEMA_VERSION: CANONICAL_RECEIPT_V1_SCHEMA_VERSION } = require('./canonical-receipt');
const { validateReceiptChain } = require('./receipt-chain');
const {
  CANONICAL_RECEIPT_V2_SCHEMA_VERSION,
  CANONICAL_RECEIPT_V2_ALLOWLIST,
  isValidTrustRoot,
  validateCanonicalReceiptV2,
} = require('./canonical-receipt-v2');

const CANONICAL_RECEIPT_V1_ALLOWLIST_SET = new Set(
  CANONICAL_RECEIPT_V2_ALLOWLIST.filter((key) => key !== 'trustRoot'),
);

// Chronological order for V4 chain-version regression checks. Higher = newer.
const V4_SCHEMA_ORDER = Object.freeze({
  [CANONICAL_RECEIPT_V1_SCHEMA_VERSION]: 1,
  [CANONICAL_RECEIPT_V2_SCHEMA_VERSION]: 2,
});

const V4_RECEIPT_ERROR_CODES = Object.freeze({
  WRITE_NOT_ENABLED: 'V4_RECEIPT_V2_WRITE_NOT_ENABLED',
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_RECEIPT_SCHEMA_VERSION',
  INVALID_TRUST_ROOT: 'INVALID_TRUST_ROOT',
  CHAIN_VERSION_REGRESSION: 'V4_CHAIN_VERSION_REGRESSION',
  BUNDLE_MIXED_FAMILY: 'RECEIPT_BUNDLE_MIXED_FAMILY',
});

/** A V4 canonical receipt payload declares a `v4-receipt-v*` schemaVersion. */
function isV4CanonicalReceipt(payload) {
  return Boolean(payload) && typeof payload === 'object'
    && typeof payload.schemaVersion === 'string' && payload.schemaVersion.startsWith('v4-receipt-v');
}

/** Classify a canonical (already-built) receipt payload by family. Does not relabel non-V4 families. */
function classifyReceiptFamily(payload) {
  return isV4CanonicalReceipt(payload) ? 'v4' : 'non-v4';
}

function isSupportedV4SchemaVersion(version) {
  return Object.hasOwn(V4_SCHEMA_ORDER, version);
}

function stripChainFields(record) {
  const payload = {};
  for (const key of Reflect.ownKeys(record)) {
    if (key === 'receiptHash' || key === 'previousReceiptHash') continue;
    payload[key] = Object.getOwnPropertyDescriptor(record, key).value;
  }
  return payload;
}

/** Exact shape validation for one V4 record, dispatched by declared schemaVersion. */
function validateV4RecordShape(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, code: V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION };
  }
  const versionDescriptor = Object.getOwnPropertyDescriptor(record, 'schemaVersion');
  if (!versionDescriptor?.enumerable || !('value' in versionDescriptor)) {
    return { valid: false, code: V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION };
  }
  const version = versionDescriptor.value;
  if (!isSupportedV4SchemaVersion(version)) {
    return { valid: false, code: V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION };
  }
  const allowedKeys = new Set([
    ...(version === CANONICAL_RECEIPT_V1_SCHEMA_VERSION
      ? CANONICAL_RECEIPT_V1_ALLOWLIST_SET
      : CANONICAL_RECEIPT_V2_ALLOWLIST),
    'previousReceiptHash', 'receiptHash',
  ]);
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== allowedKeys.size || ownKeys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor) || !allowedKeys.has(key);
  })) {
    return { valid: false, code: V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION };
  }
  const payload = stripChainFields(record);
  if (version === CANONICAL_RECEIPT_V1_SCHEMA_VERSION) {
    return { valid: true, code: null };
  }
  const v2Check = validateCanonicalReceiptV2(payload);
  return v2Check.valid
    ? { valid: true, code: null }
    : { valid: false, code: !Object.hasOwn(payload, 'trustRoot') || !isValidTrustRoot(payload.trustRoot)
      ? V4_RECEIPT_ERROR_CODES.INVALID_TRUST_ROOT
      : V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION };
}

/**
 * Version-aware validation for a V4-family chain: per-record exact shape,
 * chronological ordering (v1 -> v2 only, never v2 -> v1), then generic
 * hash/link chain validation (unchanged, not narrowed to V4).
 */
function validateV4Chain(chain, opts = {}) {
  if (!Array.isArray(chain)) {
    throw new TypeError('validateV4Chain requires an array of chained V4 receipts');
  }

  let previousOrder = 0;
  for (let i = 0; i < chain.length; i++) {
    const record = chain[i];
    if (classifyReceiptFamily(record) !== 'v4') {
      return { valid: false, brokenAt: i, code: V4_RECEIPT_ERROR_CODES.BUNDLE_MIXED_FAMILY };
    }
    const shapeCheck = validateV4RecordShape(record);
    if (!shapeCheck.valid) {
      return { valid: false, brokenAt: i, code: shapeCheck.code };
    }
    const order = V4_SCHEMA_ORDER[record.schemaVersion];
    if (order < previousOrder) {
      return { valid: false, brokenAt: i, code: V4_RECEIPT_ERROR_CODES.CHAIN_VERSION_REGRESSION };
    }
    previousOrder = order;
  }

  const generic = validateReceiptChain(chain, opts);
  if (!generic.valid) {
    return { valid: false, brokenAt: generic.brokenAt, code: null, genericReason: generic.reason };
  }
  return { valid: true, brokenAt: null, code: null, genericReason: null };
}

/**
 * Durable-write guard: called immediately after the receipt callback and
 * before chain append or database insertion (Graph.runMutationOnce).
 *
 * - non-V4 receipt family: no-op, preserved unchanged;
 * - V4 V1 payload: no-op, allowed unchanged;
 * - V4 V2-or-later payload: throws with code V4_RECEIPT_V2_WRITE_NOT_ENABLED.
 */
function assertDurableV4WriteAllowed(payload) {
  if (classifyReceiptFamily(payload) !== 'v4') return;
  if (payload.schemaVersion === CANONICAL_RECEIPT_V1_SCHEMA_VERSION) return;
  const error = new Error('durable V4 V2 (or later) canonical receipt writes are not enabled in this gate');
  error.code = V4_RECEIPT_ERROR_CODES.WRITE_NOT_ENABLED;
  throw error;
}

module.exports = {
  V4_RECEIPT_ERROR_CODES,
  isV4CanonicalReceipt,
  classifyReceiptFamily,
  isSupportedV4SchemaVersion,
  validateV4RecordShape,
  validateV4Chain,
  assertDurableV4WriteAllowed,
};
