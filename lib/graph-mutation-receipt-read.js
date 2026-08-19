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

module.exports = {
  readMutationReceiptFromJsonJournal,
  readMutationReceipt,
  getCommittedMutationReceiptByOperation,
  getCommittedMutationReceiptById,
};
