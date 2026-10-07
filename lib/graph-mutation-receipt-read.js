'use strict';

function readMutationReceiptFromJsonJournal(journal, operationId) {
  const row = journal.receipts[operationId];
  if (!row) return null;
  return {
    operationId,
    receiptId: row.receiptId,
    workspaceId: row.workspaceId,
    canonicalPayload: row.canonicalPayload,
    previousReceiptHash: row.previousReceiptHash,
    receiptHash: row.receiptHash,
    committedAt: row.committedAt,
  };
}

function readMutationReceipt(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    receiptId: row.receipt_id,
    workspaceId: row.workspace_id,
    canonicalPayload: JSON.parse(row.canonical_payload),
    previousReceiptHash: row.previous_receipt_hash,
    receiptHash: row.receipt_hash,
    committedAt: row.committed_at,
  };
}

function getCommittedMutationReceiptByOperation(storeApi, operationId) {
  if (storeApi.hasSqlite()) {
    return readMutationReceipt(storeApi.getMutationReceiptByOperation(operationId));
  }
  return readMutationReceiptFromJsonJournal(storeApi.readJsonJournal(), operationId);
}

function getCommittedMutationReceiptById(storeApi, receiptId) {
  if (storeApi.hasSqlite()) {
    return readMutationReceipt(storeApi.getMutationReceiptById(receiptId));
  }
  const journal = storeApi.readJsonJournal();
  const operationId = journal.receiptsById[receiptId];
  if (!operationId) return null;
  return readMutationReceiptFromJsonJournal(journal, operationId);
}

/**
 * Look a receipt's issuer seal up by receipt hash (#3188).
 *
 * Kept off `readMutationReceipt` on purpose: the receipt record is the hashed
 * payload, and returning the seal as one of its fields would invite a caller to
 * serialize them together -- which is exactly the circularity the seal table
 * exists to avoid. A receipt with no seal returns null, which is the ordinary
 * state when no issuer key is configured.
 */
function getMutationReceiptSeal(storeApi, receiptHash) {
  const hash = typeof receiptHash === 'string' ? receiptHash.trim() : '';
  if (!hash) return null;
  if (storeApi.hasSqlite()) {
    const row = storeApi.getMutationReceiptSeal(hash);
    if (!row) return null;
    try { return JSON.parse(row.seal); } catch (_) { return null; }
  }
  const journal = storeApi.readJsonJournal();
  return journal.seals[hash] || null;
}

/**
 * Verify the issuer seal of a committed mutation receipt (#3490, R35).
 *
 * The read-side half the seal has been missing: seals are written by
 * graph-mutation-receipt-write.js and readable via getMutationReceiptSeal,
 * but nothing verified them. Verification reuses this read path (no new
 * storage authority) and binds the signature time to evidence: the seal's
 * issuedAt must not be after the evidence time (plus tolerance). A seal from
 * the future, or one post-dating the evidence it is presented with, fails
 * closed.
 *
 * The seal primitive is injected as `verifySeal` (the composition root
 * wires it via mutationReceiptDeps) so this Core module never requires
 * the Application-ring receipt primitive itself.
 *
 * Reasons are terminal and typed: operation_id_required,
 * seal_verifier_unavailable, receipt_not_found, seal_absent,
 * seal_receipt_mismatch, no_public_key, key_fingerprint_mismatch,
 * seal_hash_mismatch, signature_invalid (+ the other verifier reasons),
 * seal_issued_at_invalid, evidence_at_invalid, seal_issued_in_future,
 * seal_issued_after_evidence.
 */
function verifyMutationReceiptSeal(storeApi, operationId, { verifySeal, publicKeyPem = '', evidenceAt = '', toleranceMs = 0 } = {}) {
  const opId = typeof operationId === 'string' ? operationId.trim() : '';
  const fail = (reason, extra = {}) => Object.freeze({
    ok: false, reason, receiptId: extra.receiptId || '', keyId: extra.keyId || '',
  });
  if (!opId) return fail('operation_id_required');
  // The seal primitive lives in the Application ring; Core receives it
  // through the caller (the composition root wires it via
  // mutationReceiptDeps) instead of requiring it. No verifier, no
  // verification -- fail closed.
  if (typeof verifySeal !== 'function') return fail('seal_verifier_unavailable');
  let receipt;
  try {
    receipt = getCommittedMutationReceiptByOperation(storeApi, opId);
  } catch (_) {
    receipt = null;
  }
  if (!receipt) return fail('receipt_not_found');
  let seal = null;
  try {
    seal = getMutationReceiptSeal(storeApi, receipt.receiptHash);
  } catch (_) {
    seal = null;
  }
  if (!seal) return fail('seal_absent', { receiptId: receipt.receiptId });
  if (seal.receiptHash !== receipt.receiptHash) {
    return fail('seal_receipt_mismatch', { receiptId: receipt.receiptId });
  }
  const checked = verifySeal(seal, publicKeyPem);
  if (!checked || !checked.ok) return fail(checked?.reason || 'signature_invalid', { receiptId: receipt.receiptId });
  const sealTime = Date.parse(seal.issuedAt);
  if (!Number.isFinite(sealTime)) return fail('seal_issued_at_invalid', { receiptId: receipt.receiptId });
  const evidenceTime = evidenceAt ? Date.parse(evidenceAt) : Date.now();
  if (!Number.isFinite(evidenceTime)) return fail('evidence_at_invalid', { receiptId: receipt.receiptId });
  const tolerance = Number.isFinite(Number(toleranceMs)) && Number(toleranceMs) >= 0 ? Number(toleranceMs) : 0;
  if (sealTime > Date.now() + tolerance) return fail('seal_issued_in_future', { receiptId: receipt.receiptId, keyId: checked.keyId });
  if (sealTime > evidenceTime + tolerance) {
    return fail('seal_issued_after_evidence', { receiptId: receipt.receiptId, keyId: checked.keyId });
  }
  return Object.freeze({
    ok: true,
    reason: '',
    receiptId: receipt.receiptId,
    keyId: checked.keyId,
    issuedAt: seal.issuedAt,
    evidenceAt: evidenceAt || new Date(evidenceTime).toISOString(),
    ageMs: evidenceTime - sealTime,
  });
}

module.exports = {
  readMutationReceiptFromJsonJournal,
  readMutationReceipt,
  getCommittedMutationReceiptByOperation,
  getCommittedMutationReceiptById,
  getMutationReceiptSeal,
  verifyMutationReceiptSeal,
};
