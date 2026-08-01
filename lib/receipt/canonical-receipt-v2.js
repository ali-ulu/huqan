'use strict';

/**
 * RECEIPT-TRUST-ROOT-3 - Canonical V2 receipt payload (ADR-009).
 *
 * Adds a trust-root-aware canonical schema on top of the unchanged V1
 * projection (./canonical-receipt.js). `trustRoot` is accepted only from
 * options; it is never inferred from receipt fields, metadata, actor,
 * source, transport, workspace, or signature presence.
 *
 * This module is a pure builder/validator. It does not write, persist, or
 * enable a production V2 receipt.
 */

const {
  CANONICAL_RECEIPT_SCHEMA_VERSION: CANONICAL_RECEIPT_V1_SCHEMA_VERSION,
  buildCanonicalReceiptPayload,
} = require('./canonical-receipt');

const CANONICAL_RECEIPT_V2_SCHEMA_VERSION = 'v4-receipt-v2';

const TRUST_ROOTS = Object.freeze(['local_operator', 'external_verified_client']);
const TRUST_ROOT_SET = new Set(TRUST_ROOTS);

// V2 canonical top-level keys = V1 canonical payload keys + trustRoot.
const CANONICAL_RECEIPT_V1_ALLOWLIST = Object.freeze([
  'schemaVersion', 'receiptId', 'receiptKind', 'decision', 'verdict', 'status',
  'admissionId', 'workspaceId', 'actor', 'agentId', 'memoryDraftId',
  'provenanceId', 'trustPolicyVersion', 'approvalId', 'approvalStatus',
  'reason', 'riskScore', 'createdAt', 'metadata',
]);
const CANONICAL_RECEIPT_V2_ALLOWLIST = Object.freeze([...CANONICAL_RECEIPT_V1_ALLOWLIST, 'trustRoot']);
const CANONICAL_RECEIPT_V2_ALLOWLIST_SET = new Set(CANONICAL_RECEIPT_V2_ALLOWLIST);
const RAW_V2_ALLOWED_KEYS = new Set([
  ...CANONICAL_RECEIPT_V1_ALLOWLIST.filter((key) => key !== 'schemaVersion'),
  'receiptType', 'canonical', 'reviewed', 'quarantined', 'rejected',
  'canonicalReceiptSchemaVersion', 'trustRoot',
]);

function isValidTrustRoot(value) {
  return typeof value === 'string' && TRUST_ROOT_SET.has(value);
}

function hasNestedAuthorityField(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'trustRoot' || key === 'canonicalReceiptSchemaVersion') return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor && hasNestedAuthorityField(descriptor.value, seen)) return true;
  }
  return false;
}

/**
 * Build the canonical V2 payload. Reuses the unchanged V1 projection and adds
 * the validated `trustRoot` from opts.trustRoot only.
 */
function buildCanonicalReceiptPayloadV2(receipt, opts = {}) {
  if (!isValidTrustRoot(opts.trustRoot)) {
    throw new TypeError(`buildCanonicalReceiptPayloadV2 requires opts.trustRoot to be one of ${TRUST_ROOTS.join(', ')} (got: ${JSON.stringify(opts.trustRoot)})`);
  }
  const v1Payload = buildCanonicalReceiptPayload(receipt, { verdict: opts.verdict });
  return {
    ...v1Payload,
    schemaVersion: CANONICAL_RECEIPT_V2_SCHEMA_VERSION,
    trustRoot: opts.trustRoot,
  };
}

/**
 * Validate an already-built canonical V2 payload: exact top-level allowlist
 * (own enumerable string keys only) plus a valid trustRoot.
 */
function validateCanonicalReceiptV2(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, reason: 'not_an_object' };
  }
  const ownKeys = Reflect.ownKeys(payload);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(payload, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)
      || !CANONICAL_RECEIPT_V2_ALLOWLIST_SET.has(key)) {
      return { valid: false, reason: 'unknown_top_level_field' };
    }
  }
  for (const key of CANONICAL_RECEIPT_V2_ALLOWLIST) {
    if (!Object.hasOwn(payload, key)) {
      return { valid: false, reason: 'missing_required_field' };
    }
  }
  if (payload.schemaVersion !== CANONICAL_RECEIPT_V2_SCHEMA_VERSION) {
    return { valid: false, reason: 'wrong_schema_version' };
  }
  if (!isValidTrustRoot(payload.trustRoot)) {
    return { valid: false, reason: 'invalid_trust_root' };
  }
  return { valid: true, reason: null };
}

/**
 * Classify a raw materialized receipt for read/export dispatch, per
 * ADR-009's materialized-receipt discriminator contract.
 *
 * - no `canonicalReceiptSchemaVersion` own key: 'legacy_v1_unspecified'
 *   (discriminator-free raw receipts follow the unchanged V1 projection);
 * - exact `canonicalReceiptSchemaVersion: v4-receipt-v2` with a valid
 *   top-level own `trustRoot`: 'v2';
 * - exact `v4-receipt-v2` discriminator with a missing/invalid/nested/
 *   inherited/non-enumerable trustRoot: 'v2_invalid_trust_root';
 * - any other declared discriminator: 'unsupported_schema_version'.
 */
function classifyRawMaterializedReceipt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'unsupported_schema_version', trustRoot: null };
  }
  if (!Object.hasOwn(raw, 'canonicalReceiptSchemaVersion')) {
    return { kind: 'legacy_v1_unspecified', trustRoot: null };
  }
  const discriminatorDescriptor = Object.getOwnPropertyDescriptor(raw, 'canonicalReceiptSchemaVersion');
  if (!discriminatorDescriptor?.enumerable || !('value' in discriminatorDescriptor)) {
    return { kind: 'unsupported_schema_version', trustRoot: null };
  }
  if (discriminatorDescriptor.value !== CANONICAL_RECEIPT_V2_SCHEMA_VERSION) {
    return { kind: 'unsupported_schema_version', trustRoot: null };
  }
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor) || !RAW_V2_ALLOWED_KEYS.has(key)) {
      return { kind: 'v2_invalid_trust_root', trustRoot: null };
    }
  }
  for (const key of Reflect.ownKeys(raw)) {
    if (key === 'trustRoot' || key === 'canonicalReceiptSchemaVersion') continue;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor && 'value' in descriptor && hasNestedAuthorityField(descriptor.value)) {
      return { kind: 'v2_invalid_trust_root', trustRoot: null };
    }
  }
  const hasOwnTrustRoot = Object.hasOwn(raw, 'trustRoot')
    && Object.getOwnPropertyDescriptor(raw, 'trustRoot').enumerable === true
    && 'value' in Object.getOwnPropertyDescriptor(raw, 'trustRoot')
    && typeof Object.getOwnPropertyDescriptor(raw, 'trustRoot').value !== 'undefined';
  const trustRoot = hasOwnTrustRoot ? Object.getOwnPropertyDescriptor(raw, 'trustRoot').value : undefined;
  if (!isValidTrustRoot(trustRoot)) {
    return { kind: 'v2_invalid_trust_root', trustRoot: null };
  }
  return { kind: 'v2', trustRoot };
}

module.exports = {
  CANONICAL_RECEIPT_V1_SCHEMA_VERSION,
  CANONICAL_RECEIPT_V2_SCHEMA_VERSION,
  TRUST_ROOTS,
  CANONICAL_RECEIPT_V2_ALLOWLIST,
  RAW_V2_ALLOWED_KEYS,
  isValidTrustRoot,
  buildCanonicalReceiptPayloadV2,
  validateCanonicalReceiptV2,
  classifyRawMaterializedReceipt,
};
