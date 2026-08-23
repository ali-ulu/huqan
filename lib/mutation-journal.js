'use strict';

/**
 * Durable mutation journal for the JSON persistence backend (issue #731).
 *
 * For the JSON backend this file is the only authority for which operationIds
 * have completed, what receipt each produced, and where each receipt chain
 * currently ends. runMutationOnce() consults it to decide whether a request is
 * a replay.
 *
 * It previously read as "parse it, and on any failure pretend there is no
 * history": a truncated, hand-edited or otherwise damaged journal turned into
 * a clean empty state. That converts an integrity failure into silent loss of
 * replay protection — an already-committed operationId re-executes, and the
 * receipt chain restarts from genesis instead of refusing to proceed.
 * atomicWriteFileSync() prevents this process from tearing its own writes; it
 * says nothing about a journal damaged by anything else.
 *
 * The rule here is the distinction that was missing: a journal that is *not
 * there* is a legitimate empty history, and a journal that *is* there but
 * cannot be read as one fails closed.
 */

const fs = require('fs');
const { withMutationJournalLock } = require('./mutation-journal-lock');

const MUTATION_JOURNAL_CORRUPT = 'MUTATION_JOURNAL_CORRUPT';

/** Sections that must be plain objects when present. */
const JOURNAL_SECTIONS = Object.freeze(['operations', 'receipts', 'chainTips', 'receiptsById']);

const SHA256_HEX = /^[0-9a-f]{64}$/;

function corrupt(message, journalPath, cause) {
  const error = new Error(`mutation journal is unusable: ${message}`);
  error.code = MUTATION_JOURNAL_CORRUPT;
  error.journalPath = journalPath;
  if (cause) error.cause = cause;
  return error;
}

const { isPlainObject } = require('./is-plain-object');

function emptyMutationJournal() {
  return { operations: {}, receipts: {}, chainTips: {}, receiptsById: {} };
}

function validateOperations(operations, journalPath) {
  for (const [operationId, entry] of Object.entries(operations)) {
    if (!isPlainObject(entry)) {
      throw corrupt(`operation ${operationId} is not an object`, journalPath);
    }
    if (typeof entry.status !== 'string' || !entry.status) {
      throw corrupt(`operation ${operationId} has no status`, journalPath);
    }
    if (entry.receiptId !== null && entry.receiptId !== undefined && typeof entry.receiptId !== 'string') {
      throw corrupt(`operation ${operationId} has a non-string receiptId`, journalPath);
    }
  }
}

function validateReceipts(receipts, journalPath) {
  for (const [operationId, entry] of Object.entries(receipts)) {
    if (!isPlainObject(entry)) {
      throw corrupt(`receipt for ${operationId} is not an object`, journalPath);
    }
    for (const field of ['receiptId', 'workspaceId', 'receiptHash']) {
      if (typeof entry[field] !== 'string' || !entry[field]) {
        throw corrupt(`receipt for ${operationId} has no ${field}`, journalPath);
      }
    }
    if (!isPlainObject(entry.canonicalPayload)) {
      throw corrupt(`receipt for ${operationId} has no canonical payload`, journalPath);
    }
  }
}

/**
 * Chain tips are sha256 hex digests produced by appendReceiptToChain(). A tip
 * that is not one cannot be used as a predecessor hash, and validating it here
 * means the check happens before an append rather than after a broken link has
 * already been written.
 */
function validateChainTips(chainTips, journalPath) {
  for (const [chainKey, tip] of Object.entries(chainTips)) {
    if (typeof tip !== 'string' || !SHA256_HEX.test(tip)) {
      throw corrupt(`chain tip for ${chainKey} is not a receipt hash`, journalPath);
    }
  }
}

function validateReceiptsById(receiptsById, journalPath) {
  for (const [receiptId, operationId] of Object.entries(receiptsById)) {
    if (typeof operationId !== 'string' || !operationId) {
      throw corrupt(`receipt index entry ${receiptId} does not name an operation`, journalPath);
    }
  }
}

/**
 * Read and structurally validate the journal.
 *
 * @throws {Error} with code MUTATION_JOURNAL_CORRUPT when a journal exists but
 *   cannot be read, parsed, or validated. Callers must not proceed with a
 *   mutation after this.
 */
function readMutationJournal(journalPath, fileSystem = fs) {
  if (!fileSystem.existsSync(journalPath)) return emptyMutationJournal();

  let raw;
  try {
    raw = fileSystem.readFileSync(journalPath, 'utf8');
  } catch (error) {
    throw corrupt('existing journal could not be read', journalPath, error);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corrupt('existing journal is not valid JSON', journalPath, error);
  }

  if (!isPlainObject(parsed)) {
    throw corrupt('existing journal is not an object', journalPath);
  }

  const journal = emptyMutationJournal();
  for (const section of JOURNAL_SECTIONS) {
    if (parsed[section] === undefined || parsed[section] === null) continue;
    if (!isPlainObject(parsed[section])) {
      throw corrupt(`${section} is not an object`, journalPath);
    }
    journal[section] = parsed[section];
  }

  validateOperations(journal.operations, journalPath);
  validateReceipts(journal.receipts, journalPath);
  validateChainTips(journal.chainTips, journalPath);
  validateReceiptsById(journal.receiptsById, journalPath);

  return journal;
}

/**
 * Guard used immediately before appending to a chain, so a tip that was
 * damaged in memory (or by a future change to the read path) cannot be linked
 * against.
 */
function assertChainTipUsable(chainTips, chainKey, journalPath) {
  const tip = chainTips[chainKey];
  if (tip === undefined || tip === null) return null;
  if (typeof tip !== 'string' || !SHA256_HEX.test(tip)) {
    throw corrupt(`chain tip for ${chainKey} is not a receipt hash`, journalPath);
  }
  return tip;
}

function readCommittedMutationResult(graph, operationId) {
  const id = typeof operationId === 'string' ? operationId.trim() : '';
  if (!id) return null;
  if (graph?._db && graph?._stmts) {
    const row = graph._stmts.getMutationJournal.get(id);
    if (!row || row.status !== 'completed') return null;
    return { operationId: id, status: row.status, result: JSON.parse(row.result), committedAt: row.completed_at, receipt: graph.getCommittedMutationReceiptByOperation(id) };
  }
  const journal = graph._readJsonJournal();
  const row = journal.operations[id];
  if (!row || row.status !== 'completed') return null;
  return { operationId: id, status: row.status, result: row.result, committedAt: row.committedAt, receipt: graph._readMutationReceiptFromJsonJournal(journal, id) };
}

function readCommittedMutationResultsByPrefix(graph, prefix) {
  const value = typeof prefix === 'string' ? prefix : '';
  if (!value || value.length > 512) return [];
  if (graph?._db && graph?._stmts) {
    const escapeLike = input => input.replace(/[\\%_]/g, character => `\\${character}`);
    return graph._db.prepare("SELECT operation_id, status, result, completed_at FROM mutation_journal WHERE operation_id LIKE ? ESCAPE '\\' ORDER BY completed_at ASC, operation_id ASC").all(`${escapeLike(value)}%`)
      .filter(row => row.status === 'completed')
      .map(row => ({ operationId: row.operation_id, status: row.status, result: JSON.parse(row.result), committedAt: row.completed_at, receipt: graph.getCommittedMutationReceiptByOperation(row.operation_id) }));
  }
  const journal = graph._readJsonJournal();
  return Object.entries(journal.operations)
    .filter(([operationId, row]) => operationId.startsWith(value) && row?.status === 'completed')
    .sort((left, right) => String(left[1].committedAt).localeCompare(String(right[1].committedAt)) || left[0].localeCompare(right[0]))
    .map(([operationId, row]) => ({ operationId, status: row.status, result: row.result, committedAt: row.committedAt, receipt: graph._readMutationReceiptFromJsonJournal(journal, operationId) }));
}

module.exports = {
  MUTATION_JOURNAL_CORRUPT,
  JOURNAL_SECTIONS,
  assertChainTipUsable,
  emptyMutationJournal,
  readMutationJournal,
  readCommittedMutationResult,
  readCommittedMutationResultsByPrefix,
  withMutationJournalLock,
};
