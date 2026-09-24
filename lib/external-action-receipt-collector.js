'use strict';

/**
 * The receiving half of #1781: take receipt batches from the machines that
 * produced them, keep tenants apart, and answer the questions the person who
 * reads receipts actually has -- which agent, when, what was blocked.
 *
 * Self-hosted first, so the store is a directory of append-only JSONL files
 * rather than a service dependency: agent action logs are among the least
 * exportable data an enterprise has, and a collector they cannot run
 * themselves is a collector they will not use. The same shape also makes the
 * store inspectable with the tools they already trust -- `grep`, `wc`, backup.
 *
 * What this module does not do is transport. It validates and stores a batch,
 * and answers queries; an HTTP route is path matching and status mapping on
 * top, the same split the Workbench routes use.
 *
 * Split by concern (#2195): validation, signature classification and the read
 * side of the store live in external-action-receipt-collector-store.js, the
 * fleet view in external-action-receipt-collector-fleet.js; this file keeps
 * the writes.
 */

const fs = require('node:fs');
const path = require('node:path');
const { queryFleet, verifyCollectorSeals } = require('./external-action-receipt-collector-fleet');
const { GENESIS_SEAL_HASH, MAX_BATCH_RECEIPTS, classifyBatchSignature, classifyIdentitySignature, failure, readIndex, readSeals, readTrustedBatchKeys, sealPath, signCollectorSeal, tenantDirectory, validateBatch } = require('./external-action-receipt-collector-store');

/**
 * Seal a stored batch and link it to this tenant's previous seal.
 *
 * The chain head is read from the file rather than kept in memory, so a
 * collector restarted mid-stream continues the same chain instead of starting
 * a second one that would look, to a reader, exactly like a deletion.
 */
function appendCollectorSeal({ directory, batch, receivedAt, sealKey }) {
  const existing = readSeals(directory);
  const previousSealHash = existing.length ? String(existing.at(-1).sealHash || GENESIS_SEAL_HASH) : GENESIS_SEAL_HASH;
  const seal = signCollectorSeal({
    batchId: batch.batchId,
    tenant: batch.tenant,
    contentHash: batch.contentHash,
    count: batch.receipts.length,
    receivedAt,
    previousSealHash,
  }, sealKey);
  if (!seal) return null;
  fs.appendFileSync(sealPath(directory), `${JSON.stringify(seal)}\n`, { mode: 0o600 });
  return seal;
}

/**
 * Accept a batch into the store.
 *
 * Re-delivery is expected, not exceptional: the shipper re-sends anything a
 * collector did not acknowledge, so a batch already stored is answered
 * `duplicate` and nothing is written twice.
 */
function ingestReceiptBatch({
  batch,
  root,
  receivedAt = new Date().toISOString(),
  trustedKeys = {},
  requireSignature = false,
  // The collector's own key. Optional, because a store that only aggregates
  // its own machine's receipts gains nothing from sealing them (#1882).
  sealKey = null,
} = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('ingestReceiptBatch requires a store root');
  const validation = validateBatch(batch);
  if (!validation.ok) return validation;

  const signature = classifyBatchSignature(batch, trustedKeys);
  // An invalid signature is refused whatever the deployment asked for. Absent
  // evidence is a state a collector can honestly record; evidence that fails
  // its own check has already contradicted itself, and storing it would put a
  // line in the trail that reads as sent-and-accepted.
  if (signature.status === 'invalid') {
    return failure('invalid_request', 'batch_signature_invalid', 'batch signature did not verify against its named key');
  }
  if (requireSignature && signature.status !== 'verified') {
    return failure('invalid_request', 'batch_signature_required', `collector requires a verified batch signature, got ${signature.status}`);
  }

  const directory = tenantDirectory(root, batch.tenant);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const indexPath = path.join(directory, 'batches.json');
  const seen = readIndex(indexPath);
  if (seen.has(batch.batchId)) {
    return Object.freeze({ ok: true, status: 'duplicate', batchId: batch.batchId, stored: 0, tenant: batch.tenant });
  }

  const trail = path.join(directory, 'receipts.jsonl');
  const trailSizeBefore = fs.existsSync(trail) ? fs.statSync(trail).size : 0;
  // The card signature carries no key id -- the envelope is exactly three
  // fields by contract -- so identity is checked against every key this
  // deployment trusts, the same way the guard itself checks it.
  const trustedKeyList = Object.values(trustedKeys || {});
  const lines = batch.receipts.map(receipt => JSON.stringify({
    ...receipt,
    collector: {
      batchId: batch.batchId,
      receivedAt,
      source: batch.source || {},
      // The collector's own finding, not the sender's claim: `verified` means
      // this store checked the signature against a key it was told to trust,
      // `unverified` that the batch was signed by a key it does not know, and
      // `unsigned` that no signature was offered. A reader can tell which
      // lines are evidence and which are merely records.
      bundleSignature: signature.status,
      signatureKeyId: signature.keyId,
      // The identity question, answered the same way: `verified` means this
      // store re-derived the card signature from the receipt itself against a
      // key it trusts, rather than reading the sending host's own
      // `signatureVerified`. The two can disagree, and a reader has to be able
      // to see that they do.
      identitySignature: classifyIdentitySignature(receipt, trustedKeyList),
    },
  })).join('\n');
  fs.appendFileSync(trail, `${lines}\n`, { mode: 0o600 });

  // Sealed after the receipts are on disk: a seal for a batch that failed to
  // store would be the collector attesting to something it does not have.
  const seal = sealKey ? appendCollectorSeal({ directory, batch, receivedAt, sealKey }) : null;
  if (sealKey && !seal) {
    // Roll back the unsealed append so a retry can safely attempt sealing
    // again without creating duplicate receipt lines.
    const handle = fs.openSync(trail, 'r+');
    try { fs.ftruncateSync(handle, trailSizeBefore); } finally { fs.closeSync(handle); }
    return failure('invalid_request', 'collector_seal_failed', 'collector could not seal the batch it stored');
  }
  fs.writeFileSync(indexPath, `${JSON.stringify({ batchIds: [...seen, batch.batchId] }, null, 2)}\n`, { mode: 0o600 });

  return Object.freeze({
    ok: true,
    status: 'stored',
    batchId: batch.batchId,
    stored: batch.receipts.length,
    tenant: batch.tenant,
    trail,
    signature: Object.freeze({ status: signature.status, keyId: signature.keyId }),
    ...(seal ? { seal } : {}),
  });
}


module.exports = Object.freeze({
  MAX_BATCH_RECEIPTS,
  ingestReceiptBatch,
  queryFleet,
  readTrustedBatchKeys,
  verifyCollectorSeals,
});
