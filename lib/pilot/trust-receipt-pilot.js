'use strict';

const crypto = require('node:crypto');

const { stableStringify } = require('../receipt/canonical-receipt');
const { hasSecretLookingValue } = require('../tool-call-gate');

const SCHEMA_VERSION = 'huqan-trust-receipt-pilot-v1';
const PUBLIC_SCHEMA_VERSION = 'huqan-trust-receipt-pilot-public-v1';
const SIGNATURE_DOMAIN = 'HUQAN/TRUST-RECEIPT-PILOT/v1';
const VERDICTS = Object.freeze(['allow', 'review', 'dry_run_only', 'block']);
const VERDICT_SET = new Set(VERDICTS);
const HASH = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SENSITIVE_KEYS = /(?:prompt|chain.?of.?thought|secret|credential|password|token|pii|raw.?tool|tool.?input|tool.?output)/i;

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value, keys) {
  return plain(value)
    && Reflect.ownKeys(value).every((key) => typeof key === 'string')
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function text(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
}

function instant(value) {
  return typeof value === 'string' && INSTANT.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalHash(value) {
  return sha256(stableStringify(value));
}

function containsForbiddenData(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key) || hasSecretLookingValue(child)) return true;
    if (containsForbiddenData(child, seen)) return true;
  }
  seen.delete(value);
  return false;
}

function cloneCanonical(value) {
  return JSON.parse(stableStringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeDeep);
  return Object.freeze(value);
}

function unsignedReceipt(input) {
  return {
    schemaVersion: SCHEMA_VERSION,
    receiptId: input.receiptId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    issuer: cloneCanonical(input.issuer),
    receiver: cloneCanonical(input.receiver),
    workspaceId: input.workspaceId,
    operation: cloneCanonical(input.operation),
    pilotRun: cloneCanonical(input.pilotRun),
    evidence: cloneCanonical(input.evidence),
    provenance: cloneCanonical(input.provenance),
    policyVersion: input.policyVersion,
    verdict: input.verdict,
    relay: cloneCanonical(input.relay),
  };
}

function signingView(receipt) {
  return { domain: SIGNATURE_DOMAIN, receipt: unsignedReceipt(receipt) };
}

function validateUnsigned(receipt, evaluationTime) {
  const keys = ['schemaVersion', 'receiptId', 'issuedAt', 'expiresAt', 'issuer', 'receiver', 'workspaceId', 'operation', 'pilotRun', 'evidence', 'provenance', 'policyVersion', 'verdict', 'relay'];
  if (!exact(receipt, keys) || receipt.schemaVersion !== SCHEMA_VERSION) return 'receipt_shape_invalid';
  if (![receipt.receiptId, receipt.workspaceId, receipt.policyVersion].every(text)
    || !instant(receipt.issuedAt) || !instant(receipt.expiresAt)) return 'receipt_shape_invalid';
  if (evaluationTime && (!instant(evaluationTime) || Date.parse(receipt.issuedAt) > Date.parse(evaluationTime)
    || Date.parse(receipt.expiresAt) <= Date.parse(evaluationTime))) return 'receipt_expired';
  if (!exact(receipt.issuer, ['id', 'keyId']) || !text(receipt.issuer.id) || !text(receipt.issuer.keyId)
    || !exact(receipt.receiver, ['id']) || !text(receipt.receiver.id)
    || !exact(receipt.operation, ['capability', 'target', 'parametersHash'])
    || !text(receipt.operation.capability) || !text(receipt.operation.target) || !HASH.test(receipt.operation.parametersHash)
    || !exact(receipt.pilotRun, ['pilotId', 'runId', 'eventId'])
    || !text(receipt.pilotRun.pilotId) || !text(receipt.pilotRun.runId) || !text(receipt.pilotRun.eventId)
    || !exact(receipt.evidence, ['type', 'digest']) || !text(receipt.evidence.type) || !HASH.test(receipt.evidence.digest)
    || !exact(receipt.provenance, ['source', 'digest']) || !text(receipt.provenance.source) || !HASH.test(receipt.provenance.digest)
    || !VERDICT_SET.has(receipt.verdict)) return 'receipt_shape_invalid';
  if (!exact(receipt.relay, ['hop', 'parentReceiptHash'])
    || !Number.isSafeInteger(receipt.relay.hop) || receipt.relay.hop < 0
    || (receipt.relay.hop === 0 ? receipt.relay.parentReceiptHash !== null : !HASH.test(receipt.relay.parentReceiptHash))) {
    return 'relay_invalid';
  }
  if (containsForbiddenData(receipt)) return 'sensitive_data_detected';
  return null;
}

function buildPilotTrustReceipt(input) {
  if (!plain(input) || !plain(input.signer) || !(input.signer.privateKey instanceof crypto.KeyObject)
    || input.signer.privateKey.type !== 'private' || input.signer.privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('pilot receipt requires an Ed25519 signer');
  }
  const unsigned = unsignedReceipt(input);
  const validation = validateUnsigned(unsigned);
  if (validation) throw new TypeError(validation);
  const receiptHash = canonicalHash(unsigned);
  const signature = crypto.sign(null, Buffer.from(stableStringify(signingView(unsigned))), input.signer.privateKey).toString('base64url');
  return freezeDeep({ ...unsigned, receiptHash, signature });
}

function projectPilotTrustReceipt(receipt) {
  const publicReceipt = {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    publicReceiptId: sha256(receipt.receiptId),
    issuedAt: receipt.issuedAt,
    disclosure: {
      issuerId: receipt.issuer.id,
      receiverId: receipt.receiver.id,
      capability: receipt.operation.capability,
      pilotId: receipt.pilotRun.pilotId,
      runId: receipt.pilotRun.runId,
      policyVersion: receipt.policyVersion,
      verdict: receipt.verdict,
      hop: receipt.relay.hop,
    },
    binding: { internalReceiptHash: receipt.receiptHash },
  };
  if (containsForbiddenData(publicReceipt)) throw new TypeError('sensitive_data_detected');
  return freezeDeep({ ...publicReceipt, projectionHash: canonicalHash(publicReceipt) });
}

function verifyPilotTrustReceipt(receipt, options = {}) {
  try {
    const fullKeys = ['schemaVersion', 'receiptId', 'issuedAt', 'expiresAt', 'issuer', 'receiver', 'workspaceId', 'operation', 'pilotRun', 'evidence', 'provenance', 'policyVersion', 'verdict', 'relay', 'receiptHash', 'signature'];
    if (!exact(receipt, fullKeys) || !HASH.test(receipt.receiptHash) || typeof receipt.signature !== 'string') return { valid: false, reason: 'receipt_shape_invalid' };
    const unsigned = unsignedReceipt(receipt);
    const invalid = validateUnsigned(unsigned, options.evaluationTime);
    if (invalid) return { valid: false, reason: invalid };
    if (canonicalHash(unsigned) !== receipt.receiptHash) return { valid: false, reason: 'receipt_tampered' };
    if (receipt.relay.hop > 0) {
      if (!options.parentReceipt || options.parentReceipt.receiptHash !== receipt.relay.parentReceiptHash
        || options.parentReceipt.relay.hop + 1 !== receipt.relay.hop
        || canonicalHash(unsignedReceipt(options.parentReceipt)) !== options.parentReceipt.receiptHash) {
        return { valid: false, reason: 'relay_parent_invalid' };
      }
    }
    const trusted = Array.isArray(options.trustedIssuers)
      ? options.trustedIssuers.find((entry) => entry.id === receipt.issuer.id && entry.keyId === receipt.issuer.keyId && entry.status === 'active')
      : null;
    if (!trusted || !(trusted.publicKey instanceof crypto.KeyObject)) return { valid: false, reason: 'unknown_issuer' };
    if (!crypto.verify(null, Buffer.from(stableStringify(signingView(unsigned))), trusted.publicKey, Buffer.from(receipt.signature, 'base64url'))) {
      return { valid: false, reason: 'signature_invalid' };
    }
    const authority = options.authority;
    if (!plain(authority) || authority.workspaceId !== receipt.workspaceId
      || authority.receiverId !== receipt.receiver.id
      || !Array.isArray(authority.capabilities) || !authority.capabilities.includes(receipt.operation.capability)) {
      return { valid: false, reason: 'scope_overreach' };
    }
    if (typeof options.replayReserve !== 'function'
      || options.replayReserve(receipt.receiptHash) !== true) return { valid: false, reason: 'replay_detected' };
    return { valid: true, reason: null, trustSignal: receipt.verdict === 'allow' };
  } catch (_) {
    return { valid: false, reason: 'verification_failed' };
  }
}

function verifyPilotPublicProjection(projection, internalReceipt) {
  try {
    if (!exact(projection, ['schemaVersion', 'publicReceiptId', 'issuedAt', 'disclosure', 'binding', 'projectionHash'])
      || !exact(projection.disclosure, ['issuerId', 'receiverId', 'capability', 'pilotId', 'runId', 'policyVersion', 'verdict', 'hop'])
      || !exact(projection.binding, ['internalReceiptHash']) || !HASH.test(projection.projectionHash)) {
      return Object.freeze({ valid: false, reason: 'projection_binding_invalid' });
    }
    const root = { schemaVersion: projection.schemaVersion, publicReceiptId: projection.publicReceiptId, issuedAt: projection.issuedAt, disclosure: projection.disclosure, binding: projection.binding };
    const expected = projectPilotTrustReceipt(internalReceipt);
    return Object.freeze({
      valid: projection.projectionHash === canonicalHash(root)
        && projection.projectionHash === expected.projectionHash
        && projection.binding.internalReceiptHash === internalReceipt.receiptHash,
      reason: projection.projectionHash === expected.projectionHash ? null : 'projection_binding_invalid',
    });
  } catch (_) {
    return Object.freeze({ valid: false, reason: 'projection_binding_invalid' });
  }
}

module.exports = {
  PUBLIC_SCHEMA_VERSION,
  SCHEMA_VERSION,
  SIGNATURE_DOMAIN,
  VERDICTS,
  buildPilotTrustReceipt,
  canonicalHash,
  projectPilotTrustReceipt,
  verifyPilotPublicProjection,
  verifyPilotTrustReceipt,
};
