'use strict';

/**
 * External-action receipt batches (#2252 split of lib/external-action-receipt-shipper.js).
 *
 * Everything a batch is before it meets a transport: tenant grouping, the
 * batch envelope, the content hash, and the optional signature. Nothing here
 * sends, retries, or advances a cursor.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  externalActionReceiptIdentity,
} = require('./external-action-identity-log');
const {
  signReceiptBatch,
  unsignedBatchSignature,
} = require('./receipt/signed-receipt-batch');

const RECEIPT_BATCH_SCHEMA = 'huqan.receipt-batch.v1';
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

/**
 * Read the deployment's batch signing key, or nothing.
 *
 * Signing is opt-in because an existing deployment has no key yet and must keep
 * shipping. It is not silent, though: once a key *is* named, a key that cannot
 * sign fails the run instead of quietly shipping `unsigned` -- an operator who
 * configured signing and got unsigned evidence would be worse off than one who
 * never configured it, because they would believe the evidence is checkable.
 */
function readSigningKey(options = {}) {
  const environment = options.environment || process.env;
  const keyPath = String(options.signingKeyPath || environment.HUQAN_RECEIPT_SIGNING_KEY || '').trim();
  const keyReference = String(options.signingKeyId || environment.HUQAN_RECEIPT_SIGNING_KEY_ID || '').trim();
  if (!keyPath && !keyReference) return null;
  if (!keyPath) throw new Error('receipt signing key id was set without HUQAN_RECEIPT_SIGNING_KEY');
  if (!keyReference) throw new Error('receipt signing key was set without HUQAN_RECEIPT_SIGNING_KEY_ID');
  let privateKeyPem;
  try {
    privateKeyPem = fs.readFileSync(path.resolve(keyPath), 'utf8');
  } catch (error) {
    throw new Error(`receipt signing key is unreadable: ${keyPath}`);
  }
  return { keyReference, privateKeyPem };
}

function tenantOf(receipt) {
  const identity = externalActionReceiptIdentity(receipt) || {};
  return {
    workspaceId: String(receipt.workspaceId || identity.workspaceId || 'default'),
    ownerActorId: String(identity.ownerActorId || 'unattested'),
  };
}

/**
 * Batches are runs of consecutive same-tenant receipts, not per-tenant piles.
 * Both properties are needed at once: a batch must hold exactly one tenant,
 * and the trail must go out in order -- because the cursor is a position in an
 * append-only file, and reordering would let it mark a receipt as shipped that
 * never was.
 */
function batchByTenantRuns(receipts, batchSize) {
  const batches = [];
  let current = null;
  for (const receipt of receipts) {
    const tenant = tenantOf(receipt);
    const key = `${tenant.workspaceId}::${tenant.ownerActorId}`;
    if (!current || current.key !== key || current.receipts.length >= batchSize) {
      current = { key, tenant, receipts: [] };
      batches.push(current);
    }
    current.receipts.push(receipt);
  }
  return batches;
}

function buildReceiptBatch({ tenant, receipts, source = {}, now = () => new Date().toISOString(), signingKey = null }) {
  const body = {
    schemaVersion: RECEIPT_BATCH_SCHEMA,
    batchId: `rcpt_batch_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt: now(),
    tenant: { workspaceId: tenant.workspaceId, ownerActorId: tenant.ownerActorId },
    source: { host: String(source.host || ''), trail: String(source.trail || '') },
    bundleSignature: unsignedBatchSignature(),
    count: receipts.length,
    receipts,
  };
  // Not a signature and never described as one: it lets a collector drop a
  // batch it already stored, and detect a transport that mangled one.
  body.contentHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(body.receipts)).digest('hex')}`;
  // Signed last, because the signature covers the content hash: signing before
  // it exists would bind an empty string and verify against any receipts.
  if (signingKey) {
    const signature = signReceiptBatch(body, signingKey);
    if (!signature) throw new Error(`receipt batch ${body.batchId} could not be signed with key ${signingKey.keyReference}`);
    body.bundleSignature = signature;
  }
  return body;
}

module.exports = Object.freeze({
  RECEIPT_BATCH_SCHEMA,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  readSigningKey,
  tenantOf,
  batchByTenantRuns,
  buildReceiptBatch,
});
