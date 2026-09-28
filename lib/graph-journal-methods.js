'use strict';

// Graph's durable mutation journal and committed-receipt reads, moved out of
// graph.js unchanged (#3101): the JSON journal surface, runMutationOnce and its
// SQLite/JSON variants, and the receipt-family schema. Installed on
// Graph.prototype by graph.js with the descriptors they had as class methods;
// `this` is the Graph instance.
//
// The receipt-chain collaborators are passed in by graph.js rather than
// required here: they sit in the Application ring and this module in Core, so
// graph.js keeps the one recorded Core -> Application edge instead of this
// file adding a new one.

const {
  jsonJournalPath: runJsonJournalPath,
  emptyJsonJournal: runEmptyJsonJournal,
  readJsonJournal: runReadJsonJournal,
  writeJsonJournal: runWriteJsonJournal,
  readMutationReceiptFromJsonJournal: runReadMutationReceiptFromJsonJournal,
  readMutationReceipt: runReadMutationReceipt,
  mutationReceiptReadStoreApi: runMutationReceiptReadStoreApi,
  getCommittedMutationResultByOperation: runCommittedMutationResult,
  getCommittedMutationResultsByPrefix: runCommittedMutationResultsByPrefix,
  runMutationOnce,
  runMutationOnceSqlite,
  runMutationOnceJson,
  runMutationOnceJsonLocked,
} = require('./graph-mutation-runtime');
const { ensureMutationReceiptFamilySchema: runMutationReceiptFamilySchema } = require('./graph-mutation-receipt-schema');
const { getCommittedMutationReceiptByOperation: runReceiptByOperationRead, getCommittedMutationReceiptById: runReceiptByIdRead } = require('./graph-mutation-receipt-read');
const { installGraphMethods } = require('./graph-method-install');

function install(Graph, mutationReceiptDeps) {
  class GraphJournalMethods {
  _ensureMutationReceiptFamilySchema() {
    return runMutationReceiptFamilySchema(this._db);
  }

  /**
   * JSON-backend durable mutation journal file, sibling to memoryPath (same
   * naming convention as _embeddingPath). Structure mirrors the SQLite
   * mutation_journal/mutation_receipts tables closely enough to reuse the
   * exact same receipt-chain logic (appendReceiptToChain/classifyReceiptFamily):
   *   { operations: { [operationId]: { status, result, receiptId, committedAt } },
   *     receipts:   { [operationId]: { receiptId, workspaceId, receiptFamily,
   *                                     canonicalPayload, previousReceiptHash,
   *                                     receiptHash, committedAt } },
   *     chainTips:  { [`${workspaceId}::${receiptFamily}`]: receiptHash },
   *     receiptsById: { [receiptId]: operationId } }
   *
   * Public journal-path surface for the JSON backend (#2343, #2353).
   */
  jsonJournalPath() { return runJsonJournalPath(this); }

  _emptyJsonJournal() { return runEmptyJsonJournal(); }

  readJsonJournal() { return runReadJsonJournal(this); }

  _readJsonJournal() { return this.readJsonJournal(); }

  _writeJsonJournal(journal) { return runWriteJsonJournal(this, journal); }

  _readMutationReceiptFromJsonJournal(journal, operationId) {
    return runReadMutationReceiptFromJsonJournal(journal, operationId);
  }

  _readMutationReceipt(row) { return runReadMutationReceipt(row); }

  getCommittedMutationReceiptByOperation(operationId) {
    return runReceiptByOperationRead(this._mutationReceiptReadStoreApi(), operationId);
  }

  getCommittedMutationReceiptById(receiptId) {
    return runReceiptByIdRead(this._mutationReceiptReadStoreApi(), receiptId);
  }

  _mutationReceiptReadStoreApi() { return runMutationReceiptReadStoreApi(this); }

  getCommittedMutationResultByOperation(operationId) { return runCommittedMutationResult(this, operationId); }

  getCommittedMutationResultsByPrefix(prefix) { return runCommittedMutationResultsByPrefix(this, prefix); }

  runMutationOnce(operationId, mutate, opts = {}) { return runMutationOnce(this, operationId, mutate, opts, mutationReceiptDeps); }

  _runMutationOnceSqlite(id, mutate, opts) { return runMutationOnceSqlite(this, id, mutate, opts, mutationReceiptDeps); }

  _runMutationOnceJson(id, mutate, opts) { return runMutationOnceJson(this, id, mutate, opts, mutationReceiptDeps); }

  _runMutationOnceJsonLocked(id, mutate, opts) { return runMutationOnceJsonLocked(this, id, mutate, opts, mutationReceiptDeps); }
  }

  installGraphMethods(Graph, GraphJournalMethods);
}

module.exports = { install };
