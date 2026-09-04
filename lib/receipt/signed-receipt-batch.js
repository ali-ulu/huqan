'use strict';

/**
 * Ed25519 signatures for shipped external-action receipt batches (#1859).
 *
 * Why a batch needs one at all: the guard writes its own receipts, so the
 * machine that produced the evidence is the machine the evidence is about. A
 * `contentHash` -- which the batch already carries -- tells a collector that
 * the bytes it received are the bytes that were sent, and lets it drop a
 * duplicate. It says nothing about who sent them, because anyone who edits the
 * receipts can recompute it. A signature is the part that binds the batch to a
 * key holder and fails the moment a field changes.
 *
 * What it still does not prove: the key lives on the host being audited, so a
 * valid signature means "this batch left that installation unchanged", never
 * "the operator did not doctor it before signing". Evidence *against* an
 * operator needs the collector to counter-seal with a key that host cannot
 * reach; that is a separate change, and the claim -- not this mechanism --
 * is what differs between a self-hosted and a hosted collector.
 *
 * Key distribution stays a deployment concern, as it is for identity cards:
 * this module verifies a signature against a public key the caller supplies
 * and never decides which keys deserve trust.
 */

const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-receipt');

const RECEIPT_BATCH_SIGNATURE_VERSION = 'huqan.receipt-batch-signature.v1';
const SIGNATURE_ALGORITHM = 'ed25519';

const SIGNATURE_STATUS = Object.freeze({
  UNSIGNED: 'unsigned',
  SIGNED: 'signed',
});

/**
 * The signed statement. `contentHash` already covers every receipt in the
 * batch, so covering it here binds the whole payload without signing megabytes;
 * the identity fields are covered directly, because a batch moved to another
 * tenant with the same receipts would otherwise still verify.
 *
 * The signature envelope itself is deliberately absent: a signature cannot
 * cover its own bytes.
 */
function canonicalBatchSignaturePayload(batch) {
  return {
    schemaVersion: RECEIPT_BATCH_SIGNATURE_VERSION,
    batchSchemaVersion: String(batch.schemaVersion || ''),
    batchId: String(batch.batchId || ''),
    createdAt: String(batch.createdAt || ''),
    workspaceId: String(batch.tenant?.workspaceId || ''),
    ownerActorId: String(batch.tenant?.ownerActorId || ''),
    count: Number.isInteger(batch.count) ? batch.count : -1,
    contentHash: String(batch.contentHash || ''),
  };
}

function canonicalBytes(batch) {
  return Buffer.from(stableStringify(canonicalBatchSignaturePayload(batch)), 'utf8');
}

function unsignedBatchSignature() {
  return Object.freeze({ status: SIGNATURE_STATUS.UNSIGNED, algorithm: '', value: '', keyId: '' });
}

/**
 * Sign a batch that already carries its `contentHash`.
 *
 * Returns null on anything malformed -- a missing key, a key of the wrong type,
 * a batch with no content hash -- so a caller that asked for signing can fail
 * closed rather than ship a batch that merely looks signed.
 */
function signReceiptBatch(batch, { keyReference, privateKeyPem } = {}) {
  if (!batch || typeof batch !== 'object') return null;
  if (typeof keyReference !== 'string' || !keyReference) return null;
  if (typeof privateKeyPem !== 'string' || !privateKeyPem) return null;
  if (typeof batch.contentHash !== 'string' || !batch.contentHash) return null;
  try {
    const key = crypto.createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) return null;
    return Object.freeze({
      status: SIGNATURE_STATUS.SIGNED,
      schemaVersion: RECEIPT_BATCH_SIGNATURE_VERSION,
      algorithm: SIGNATURE_ALGORITHM,
      value: crypto.sign(null, canonicalBytes(batch), key).toString('base64'),
      keyId: keyReference,
    });
  } catch (_) {
    return null;
  }
}

/**
 * True only for a signature this key really made over this batch. Every
 * malformed shape returns false rather than throwing: a collector decides what
 * to do about an unverifiable batch, and must never be handed an exception in
 * place of an answer.
 */
function verifyReceiptBatchSignature(batch, publicKeyPem) {
  const envelope = batch && batch.bundleSignature;
  if (!envelope || envelope.status !== SIGNATURE_STATUS.SIGNED) return false;
  if (envelope.schemaVersion !== RECEIPT_BATCH_SIGNATURE_VERSION) return false;
  if (envelope.algorithm !== SIGNATURE_ALGORITHM || typeof envelope.value !== 'string') return false;
  if (typeof publicKeyPem !== 'string' || !publicKeyPem) return false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) return false;
    const signature = Buffer.from(envelope.value, 'base64');
    if (signature.length !== 64) return false;
    return crypto.verify(null, canonicalBytes(batch), key, signature);
  } catch (_) {
    return false;
  }
}

module.exports = Object.freeze({
  RECEIPT_BATCH_SIGNATURE_VERSION,
  SIGNATURE_STATUS,
  canonicalBatchSignaturePayload,
  signReceiptBatch,
  unsignedBatchSignature,
  verifyReceiptBatchSignature,
});
