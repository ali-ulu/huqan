'use strict';

// #2195: the collector store's limits, tenant layout, batch validation,
// signature classification and the read side of the index and seal chain.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// The collector's only edge to the seal chain (receipt/collector-seal.js):
// the write side and the fleet view take it from here.
const { GENESIS_SEAL_HASH, signCollectorSeal, verifyCollectorSealChain } = require('./receipt/collector-seal');
const { resolvePathWithinRoot } = require('./path-safety');
const { RECEIPT_BATCH_SCHEMA } = require('./external-action-receipt-shipper');
const { externalActionReceiptIdentity } = require('./external-action-identity-log');
const { verifyReceiptBatchSignature } = require('./receipt/signed-receipt-batch');
const { verifyReceiptIdentityCardSignature } = require('./external-action-identity-signing');

const MAX_BATCH_RECEIPTS = 1000;
const MAX_QUERY_LINES = 50000;
const DEFAULT_FLEET_LIMIT = 100;

function failure(status, code, message) {
  return Object.freeze({ ok: false, status, error: { code, message } });
}

/**
 * Tenant identifiers arrive from a remote host, so they name a directory only
 * after being reduced to a conservative slug -- and the resolved path is
 * checked against the root anyway. Neither alone is enough: the slug stops
 * `../` from ever forming, the containment check stops anything the slug
 * missed from landing outside the store.
 */
function slug(value) {
  const cleaned = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 64) || 'unknown';
}

function tenantDirectory(root, tenant) {
  const target = path.join(path.resolve(root), slug(tenant.workspaceId), slug(tenant.ownerActorId));
  return resolvePathWithinRoot(path.resolve(root), target, { allowMissing: true });
}

function contentHashOf(receipts) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(receipts)).digest('hex')}`;
}

function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return failure('invalid_request', 'batch_not_an_object', 'batch must be an object');
  if (batch.schemaVersion !== RECEIPT_BATCH_SCHEMA) return failure('invalid_request', 'unsupported_schema', `expected ${RECEIPT_BATCH_SCHEMA}`);
  if (typeof batch.batchId !== 'string' || !batch.batchId.trim()) return failure('invalid_request', 'batch_id_required', 'batchId is required');
  const tenant = batch.tenant;
  if (!tenant || typeof tenant.workspaceId !== 'string' || typeof tenant.ownerActorId !== 'string') {
    return failure('invalid_request', 'tenant_required', 'tenant.workspaceId and tenant.ownerActorId are required');
  }
  if (!Array.isArray(batch.receipts) || !batch.receipts.length) return failure('invalid_request', 'receipts_required', 'receipts must be a non-empty array');
  if (batch.receipts.length > MAX_BATCH_RECEIPTS) return failure('limit_exceeded', 'too_many_receipts', `at most ${MAX_BATCH_RECEIPTS} receipts per batch`);
  // The hash is a transport check, not a signature, and it is treated as
  // exactly that: a mismatch means the batch arrived damaged or rewritten in
  // flight, which is a reason to refuse it, not evidence about its origin.
  if (typeof batch.contentHash === 'string' && batch.contentHash !== contentHashOf(batch.receipts)) {
    return failure('invalid_request', 'content_hash_mismatch', 'contentHash does not match the receipts');
  }
  // A batch is one tenant's, decided by the sender and re-checked here: a
  // collector that accepted a mixed batch would file another tenant's evidence
  // under the wrong owner, which is worse than losing it.
  const foreign = batch.receipts.find(receipt => {
    const identity = externalActionReceiptIdentity(receipt) || {};
    const workspaceId = String(receipt.workspaceId || identity.workspaceId || 'default');
    const ownerActorId = String(identity.ownerActorId || 'unattested');
    return workspaceId !== tenant.workspaceId || ownerActorId !== tenant.ownerActorId;
  });
  if (foreign) return failure('invalid_request', 'mixed_tenant_batch', `receipt ${foreign.receiptId || ''} does not belong to the batch tenant`);
  return { ok: true };
}

function readIndex(target) {
  try { return new Set(JSON.parse(fs.readFileSync(target, 'utf8')).batchIds || []); } catch (_) { return new Set(); }
}

/**
 * What this store can say about a batch's signature, in its own voice.
 *
 * Four answers, and the difference between the middle two is the point:
 * `unsigned` means the sender offered nothing, `unverified` means it offered a
 * signature from a key this deployment was never told to trust. Both are
 * storable; only `verified` is evidence. `invalid` is a signature that failed
 * against the very key it named, which is not a gap but a contradiction.
 *
 * Key distribution stays the deployment's business: the caller passes the
 * public keys it trusts, exactly as the identity-card path does.
 */
function classifyBatchSignature(batch, trustedKeys = {}) {
  const envelope = batch && batch.bundleSignature;
  const keyId = String(envelope?.keyId || '');
  if (!envelope || envelope.status !== 'signed') return { status: 'unsigned', keyId: '' };
  const publicKeyPem = keyId && Object.prototype.hasOwnProperty.call(trustedKeys, keyId) ? trustedKeys[keyId] : '';
  if (!publicKeyPem) return { status: 'unverified', keyId };
  return { status: verifyReceiptBatchSignature(batch, publicKeyPem) ? 'verified' : 'invalid', keyId };
}

/**
 * What this store can say about *who* produced a receipt, as opposed to who
 * shipped the batch it arrived in.
 *
 * `unattested` is a receipt whose action carried no capability card at all;
 * `none` is an attested one that carried no signature to check; `unverified`
 * is a signature no trusted key accounts for; `verified` is the only one this
 * store worked out for itself. The receipt's own `signatureVerified` is never
 * consulted here -- it is the claim this is meant to replace (#1859).
 */
function classifyIdentitySignature(receipt, trustedKeyList) {
  const identity = receipt?.metadata?.identity;
  if (!identity || identity.attested !== true) return 'unattested';
  if (!identity.cardSignature) return 'none';
  return verifyReceiptIdentityCardSignature(identity, trustedKeyList) ? 'verified' : 'unverified';
}

/**
 * Load the public keys a deployment has decided to trust: one PEM file per
 * key, the file name without its extension being the `keyId` the sender puts
 * in its signature. A directory rather than a config blob because that is how
 * an operator already handles keys -- copy a file in, remove it to revoke.
 *
 * An unreadable directory yields no keys rather than throwing: a collector
 * with no trusted keys still stores batches, marked `unverified`, which is a
 * truthful state. Failing to boot over it would trade evidence for silence.
 */
function readTrustedBatchKeys(directory) {
  const base = String(directory || '').trim();
  if (!base) return {};
  const keys = {};
  try {
    for (const entry of fs.readdirSync(path.resolve(base), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const keyId = entry.name.replace(/\.(pem|pub|key)$/i, '');
      if (!keyId) continue;
      try { keys[keyId] = fs.readFileSync(path.join(path.resolve(base), entry.name), 'utf8'); } catch (_) { /* skip */ }
    }
  } catch (_) {
    return keys;
  }
  return keys;
}

function sealPath(directory) {
  return path.join(directory, 'seals.jsonl');
}

function readSeals(directory) {
  try {
    return fs.readFileSync(sealPath(directory), 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = {
  GENESIS_SEAL_HASH,
  signCollectorSeal,
  verifyCollectorSealChain,
  DEFAULT_FLEET_LIMIT,
  MAX_BATCH_RECEIPTS,
  MAX_QUERY_LINES,
  classifyBatchSignature,
  classifyIdentitySignature,
  failure,
  readIndex,
  readSeals,
  readTrustedBatchKeys,
  sealPath,
  slug,
  tenantDirectory,
  validateBatch,
};
