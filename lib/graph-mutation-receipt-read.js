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

module.exports = {
  readMutationReceiptFromJsonJournal,
  readMutationReceipt,
  getCommittedMutationReceiptByOperation,
  getCommittedMutationReceiptById,
  getMutationReceiptSeal,
};
