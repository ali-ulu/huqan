'use strict';

/**
 * RECEIPT-TRUST-ROOT-3 - V4-family classification, version-aware chain
 * validation, and the durable-write guard (ADR-008/ADR-009).
 *
 * Generic hash/link chain validation (./receipt-chain.js) remains unchanged
 * and is not narrowed to V4 schemas. This module adds a V4-scoped layer on
 * top of it: exact per-record shape validation for each supported V4 schema
 * version, chronological version-ordering, and a durable-write guard that
 * fails closed for any V2-or-later V4 write unless an exact source-owned
 * contract is recognized.
 */

const {
  CANONICAL_RECEIPT_SCHEMA_VERSION: CANONICAL_RECEIPT_V1_SCHEMA_VERSION,
  stableStringify,
  sha256Hex,
} = require('./canonical-receipt');
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

const EXTERNAL_CANDIDATE_OPERATION_PATTERN =
  /^external-client-candidate-claim:external-client-authority-0-v1:[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EXTERNAL_CANDIDATE_METADATA_KEYS = Object.freeze([
  'mutationKind',
  'operationId',
  'packageId',
  'packageHash',
  'replayKey',
  'trustedKeyId',
  'externalCandidateId',
  'localCandidateId',
  'externalCandidateHash',
]);
const EXTERNAL_CANDIDATE_CONTEXT_KEYS = Object.freeze(['operationId']);
const EXTERNAL_CANDIDATE_OWNER_VERSION =
  'external-client-mutation-receipt-owner-0-v1';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataObject(value, keys) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) return false;
  return ownKeys.every((key) => {
    if (typeof key !== 'string' || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  });
}

function dataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function canonicalInstant(value) {
  if (!nonEmptyText(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isAuthorizedExternalCandidateV2Write(payload, context) {
  try {
    if (!exactDataObject(context, EXTERNAL_CANDIDATE_CONTEXT_KEYS)) return false;
    const operationId = dataValue(context, 'operationId');
    if (typeof operationId !== 'string'
      || !EXTERNAL_CANDIDATE_OPERATION_PATTERN.test(operationId)) return false;

    const v2 = validateCanonicalReceiptV2(payload);
    if (!v2.valid
      || payload.schemaVersion !== CANONICAL_RECEIPT_V2_SCHEMA_VERSION
      || payload.trustRoot !== 'external_verified_client'
      || payload.receiptKind !== 'external_client_candidate_claim_admission'
      || payload.verdict !== 'review'
      || payload.decision !== 'review'
      || payload.status !== 'pending'
      || payload.admissionId !== operationId
      || payload.trustPolicyVersion !== EXTERNAL_CANDIDATE_OWNER_VERSION
      || payload.approvalId !== ''
      || payload.approvalStatus !== 'pending'
      || payload.reason !== 'external_verified_candidate_requires_review'
      || payload.riskScore !== 0
      || !nonEmptyText(payload.workspaceId)
      || !nonEmptyText(payload.actor)
      || payload.agentId !== payload.actor
      || !canonicalInstant(payload.createdAt)
      || !exactDataObject(payload.metadata, EXTERNAL_CANDIDATE_METADATA_KEYS)) {
      return false;
    }

    const metadata = payload.metadata;
    const replayKey = operationId.slice('external-client-candidate-claim:'.length);
    if (metadata.mutationKind !== 'external_client_candidate_claim_quarantine'
      || metadata.operationId !== operationId
      || metadata.replayKey !== replayKey
      || !nonEmptyText(metadata.packageId)
      || !HASH_PATTERN.test(metadata.packageHash)
      || !nonEmptyText(metadata.trustedKeyId)
      || !nonEmptyText(metadata.externalCandidateId)
      || !HASH_PATTERN.test(metadata.externalCandidateHash)
      || !/^external_candidate_[a-f0-9]{64}$/.test(metadata.localCandidateId)
      || payload.memoryDraftId !== metadata.localCandidateId
      || payload.receiptId !== `external_candidate_receipt_${sha256Hex(operationId)}`
      || !payload.provenanceId.startsWith(`external:${metadata.packageHash}:`)) {
      return false;
    }

    const expectedLocalCandidateId = `external_candidate_${sha256Hex(stableStringify({
      ownerVersion: EXTERNAL_CANDIDATE_OWNER_VERSION,
      workspaceId: payload.workspaceId,
      packageHash: metadata.packageHash,
      externalCandidateId: metadata.externalCandidateId,
    }))}`;
    return metadata.localCandidateId === expectedLocalCandidateId;
  } catch (_) {
    return false;
  }
}

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
 * - one exact external-client candidate-quarantine V2 payload: allowed only
 *   when its authoritative operation lineage is supplied by Graph;
 * - every other V4 V2-or-later payload: fail closed.
 */
function assertDurableV4WriteAllowed(payload, context = undefined) {
  if (classifyReceiptFamily(payload) !== 'v4') return;
  if (payload.schemaVersion === CANONICAL_RECEIPT_V1_SCHEMA_VERSION) return;
  if (payload.schemaVersion === CANONICAL_RECEIPT_V2_SCHEMA_VERSION
    && isAuthorizedExternalCandidateV2Write(payload, context)) return;
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
