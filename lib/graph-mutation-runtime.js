const { atomicWriteFileSync, nowIso } = require('./graph-record-utils');
const { createMutationRollback } = require('./graph-mutation-rollback');
const {
  commitJsonTransaction,
  rememberSnapshot,
  runSnapshotMutation,
} = require('./graph-json-snapshot');
const {
  assertChainTipUsable,
  emptyMutationJournal,
  readMutationJournal,
  readCommittedMutationResult,
  readCommittedMutationResultsByPrefix,
} = require('./mutation-journal');
const {
  readMutationReceiptFromJsonJournal,
  readMutationReceipt,
  getCommittedMutationReceiptByOperation: readReceiptByOperation,
  getCommittedMutationReceiptById: readReceiptById,
  getMutationReceiptSeal: readReceiptSeal,
} = require('./graph-mutation-receipt-read');
const { writeChainedMutationReceipt, sealChainedReceipt } = require('./graph-mutation-receipt-write');
const { assertGraphPersistenceWritable } = require('./graph-json-persistence');

// Read once: the seal records which build produced the receipt, and a version
// that changed mid-process would make two receipts from one run disagree.
const PRODUCT_VERSION = require('../package.json').version || '';

function jsonJournalPath(graph) {
  return graph._paths.journalPath;
}

function emptyJsonJournal() {
  return emptyMutationJournal();
}

function readJsonJournal(graph) {
  return readMutationJournal(graph.jsonJournalPath());
}

function writeJsonJournal(graph, journal) {
  atomicWriteFileSync(graph.jsonJournalPath(), JSON.stringify(journal));
}

function mutationReceiptReadStoreApi(graph) {
  return {
    hasSqlite: () => Boolean(graph._db && graph._stmts),
    getMutationReceiptByOperation: id => graph._stmts.getMutationReceiptByOperation.get(id),
    getMutationReceiptById: id => graph._stmts.getMutationReceiptById.get(id),
    getMutationReceiptSeal: hash => graph._stmts.getMutationReceiptSeal.get(hash),
    readJsonJournal: () => readJsonJournal(graph),
  };
}

/**
 * The small surface the sealed-write delegate expects (#3188). The key is read
 * once at composition time and handed over here rather than looked up per
 * write: the delegate stays a pure builder and the Core ring never grows an
 * import of the configuration module.
 */
function mutationReceiptWriteStore(graph) {
  return {
    getLatestReceiptHash: (workspaceId, receiptFamily) =>
      graph._stmts.getLatestMutationReceiptHash.get(workspaceId, receiptFamily)?.receipt_hash,
    insertReceipt: (...args) => graph._stmts.insertMutationReceipt.run(...args),
    insertSeal: (...args) => graph._stmts.insertMutationReceiptSeal.run(...args),
    now: nowIso,
    productVersion: PRODUCT_VERSION,
    issuerKey: graph._issuerKey || null,
  };
}

function getCommittedMutationReceiptByOperation(graph, operationId) {
  return readReceiptByOperation(mutationReceiptReadStoreApi(graph), operationId);
}

function getCommittedMutationReceiptById(graph, receiptId) {
  return readReceiptById(mutationReceiptReadStoreApi(graph), receiptId);
}

/**
 * The issuer seal for a receipt, by receipt hash (#3188). Null when the receipt
 * was written with no issuer key configured, which is the default.
 */
function getMutationReceiptSealByHash(graph, receiptHash) {
  return readReceiptSeal(mutationReceiptReadStoreApi(graph), receiptHash);
}

/**
 * The issuer seal for a committed receipt, by operation id (#3188). A receipt
 * the operation never produced, or one written unsealed, answers null.
 */
function getMutationReceiptSealByOperation(graph, operationId) {
  const receipt = getCommittedMutationReceiptByOperation(graph, operationId);
  if (!receipt) return null;
  return getMutationReceiptSealByHash(graph, receipt.receiptHash);
}

function getCommittedMutationResultByOperation(graph, operationId) {
  return readCommittedMutationResult(graph, operationId);
}

function getCommittedMutationResultsByPrefix(graph, prefix) {
  return readCommittedMutationResultsByPrefix(graph, prefix);
}

function runMutationOnce(graph, operationId, mutate, opts = {}, receiptDeps) {
  assertGraphPersistenceWritable(graph);
  const id = typeof operationId === 'string' ? operationId.trim() : '';
  if (!id) throw new Error('mutation operationId is required');
  if (typeof mutate !== 'function') throw new TypeError('mutation callback is required');
  if (graph._db && graph._stmts) return runMutationOnceSqlite(graph, id, mutate, opts, receiptDeps);
  return runMutationOnceJson(graph, id, mutate, opts, receiptDeps);
}

function runMutationOnceSqlite(graph, id, mutate, opts, receiptDeps) {
  // better-sqlite3 turns a nested transaction into a savepoint, so an inner
  // operation would commit its journal row under the outer one. Refuse it, as
  // the JSON backend does, so both backends share one nesting contract.
  if (graph._sqliteMutationInFlight) {
    const error = new Error('Nested SQLite graph mutations are not supported.');
    error.code = 'GRAPH_NESTED_MUTATION';
    throw error;
  }
  const { appendReceiptToChain, assertDurableV4WriteAllowed, classifyReceiptFamily } = receiptDeps;
  const readStored = () => {
    const row = graph._stmts.getMutationJournal.get(id);
    return row && row.status === 'completed' ? JSON.parse(row.result) : null;
  };
  const stored = readStored();
  if (stored !== null) {
    return { replayed: true, result: stored, receipt: graph.getCommittedMutationReceiptByOperation(id) };
  }

  const previousRollback = graph._mutationRollback;
  const rollback = createMutationRollback(graph);
  graph._mutationRollback = rollback;
  graph._sqliteMutationInFlight = true;
  try {
    const execute = graph._db.transaction(() => {
      const alreadyCompleted = readStored();
      if (alreadyCompleted !== null) {
        return { replayed: true, result: alreadyCompleted, receipt: graph.getCommittedMutationReceiptByOperation(id) };
      }
      const result = mutate();
      let receipt = null;
      if (typeof opts.buildCanonicalReceipt === 'function') {
        const payload = opts.buildCanonicalReceipt(result);
        if (payload !== null && payload !== undefined) {
          if (typeof payload !== 'object' || !payload.receiptId || !payload.workspaceId) {
            throw new Error('durable mutation receipt payload is invalid');
          }
          assertDurableV4WriteAllowed(payload, { operationId: id });
          const receiptFamily = classifyReceiptFamily(payload);
          // #3188: one delegate owns chaining, sealing and storing so the seal
          // cannot be skipped by a second inline copy of this block drifting.
          // Everything here runs inside the outer transaction, so a sign or
          // seal-insert failure rolls back node + receipt + journal together.
          writeChainedMutationReceipt(mutationReceiptWriteStore(graph), {
            operationId: id, payload, receiptFamily,
          });
          receipt = readMutationReceipt(graph._stmts.getMutationReceiptByOperation.get(id));
        }
      }
      graph._stmts.insertMutationJournal.run(id, 'completed', JSON.stringify(result), nowIso());
      return { replayed: false, result, receipt };
    });
    return (typeof execute.immediate === 'function' ? execute.immediate : execute)();
  } catch (error) {
    rollback.restore();
    const completed = readStored();
    if (completed !== null) {
      return { replayed: true, result: completed, receipt: graph.getCommittedMutationReceiptByOperation(id) };
    }
    throw error;
  } finally {
    graph._sqliteMutationInFlight = false;
    graph._mutationRollback = previousRollback;
  }
}

function runMutationOnceJson(graph, id, mutate, opts, receiptDeps) {
  return runSnapshotMutation(
    graph,
    () => runMutationOnceJsonLocked(graph, id, mutate, opts, receiptDeps),
    graph._jsonTransactionFault,
  );
}

function runMutationOnceJsonLocked(graph, id, mutate, opts, receiptDeps) {
  const { appendReceiptToChain, assertDurableV4WriteAllowed, classifyReceiptFamily } = receiptDeps;
  const readStored = () => {
    const journal = readJsonJournal(graph);
    const op = journal.operations[id];
    return op && op.status === 'completed' ? { result: op.result, journal } : null;
  };

  const alreadyCompleted = readStored();
  if (alreadyCompleted !== null) {
    return {
      replayed: true,
      result: alreadyCompleted.result,
      receipt: readMutationReceiptFromJsonJournal(alreadyCompleted.journal, id),
    };
  }

  const previousRollback = graph._mutationRollback;
  const rollback = createMutationRollback(graph);
  graph._mutationRollback = rollback;
  try {
    const recheck = readStored();
    if (recheck !== null) {
      return {
        replayed: true,
        result: recheck.result,
        receipt: readMutationReceiptFromJsonJournal(recheck.journal, id),
      };
    }

    const result = mutate();
    const journal = readJsonJournal(graph);
    let receipt = null;

    if (typeof opts.buildCanonicalReceipt === 'function') {
      const payload = opts.buildCanonicalReceipt(result);
      if (payload !== null && payload !== undefined) {
        if (typeof payload !== 'object' || !payload.receiptId || !payload.workspaceId) {
          throw new Error('durable mutation receipt payload is invalid');
        }
        assertDurableV4WriteAllowed(payload, { operationId: id });
        const receiptFamily = classifyReceiptFamily(payload);
        const chainKey = `${payload.workspaceId}::${receiptFamily}`;
        const previousReceiptHash = assertChainTipUsable(journal.chainTips, chainKey, graph.jsonJournalPath());
        const chained = appendReceiptToChain(payload, previousReceiptHash);
        const committedAt = nowIso();
        journal.receipts[id] = {
          receiptId: chained.receiptId,
          workspaceId: payload.workspaceId,
          receiptFamily,
          canonicalPayload: payload,
          previousReceiptHash: chained.previousReceiptHash,
          receiptHash: chained.receiptHash,
          committedAt,
        };
        journal.receiptsById[chained.receiptId] = id;
        journal.chainTips[chainKey] = chained.receiptHash;
        // #3188: same rule as SQLite -- the seal is keyed by receipt hash and
        // never enters the receipt row. Written into the same journal the JSON
        // transaction commits, so recovery keeps it verifiable.
        const seal = sealChainedReceipt(chained, graph._issuerKey, {
          issuedAt: committedAt,
          productVersion: PRODUCT_VERSION,
        });
        if (seal) journal.seals[seal.receiptHash] = seal;
        receipt = readMutationReceiptFromJsonJournal(journal, id);
      }
    }

    journal.operations[id] = {
      status: 'completed',
      result,
      receiptId: receipt?.receiptId || null,
      committedAt: nowIso(),
    };
    commitJsonTransaction(graph, id, journal, graph._jsonTransactionFault);
    rememberSnapshot(graph);
    return { replayed: false, result, receipt, persisted: true };
  } catch (error) {
    rollback.restore();
    const completed = readStored();
    if (completed !== null) {
      return {
        replayed: true,
        result: completed.result,
        receipt: readMutationReceiptFromJsonJournal(completed.journal, id),
      };
    }
    throw error;
  } finally {
    graph._mutationRollback = previousRollback;
  }
}

module.exports = {
  jsonJournalPath,
  emptyJsonJournal,
  readJsonJournal,
  writeJsonJournal,
  readMutationReceiptFromJsonJournal,
  readMutationReceipt,
  getCommittedMutationReceiptByOperation,
  getCommittedMutationReceiptById,
  getMutationReceiptSealByHash,
  getMutationReceiptSealByOperation,
  mutationReceiptReadStoreApi,
  getCommittedMutationResultByOperation,
  getCommittedMutationResultsByPrefix,
  runMutationOnce,
  runMutationOnceSqlite,
  runMutationOnceJson,
  runMutationOnceJsonLocked,
};
