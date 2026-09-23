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
} = require('./graph-mutation-receipt-read');
const { assertGraphPersistenceWritable } = require('./graph-json-persistence');

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
    readJsonJournal: () => readJsonJournal(graph),
  };
}

function getCommittedMutationReceiptByOperation(graph, operationId) {
  return readReceiptByOperation(mutationReceiptReadStoreApi(graph), operationId);
}

function getCommittedMutationReceiptById(graph, receiptId) {
  return readReceiptById(mutationReceiptReadStoreApi(graph), receiptId);
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
          const previous = graph._stmts.getLatestMutationReceiptHash.get(payload.workspaceId, receiptFamily);
          const chained = appendReceiptToChain(payload, previous?.receipt_hash);
          const committedAt = nowIso();
          graph._stmts.insertMutationReceipt.run(
            id, chained.receiptId, payload.workspaceId, receiptFamily, JSON.stringify(payload),
            chained.previousReceiptHash, chained.receiptHash, committedAt,
          );
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
  mutationReceiptReadStoreApi,
  getCommittedMutationResultByOperation,
  getCommittedMutationResultsByPrefix,
  runMutationOnce,
  runMutationOnceSqlite,
  runMutationOnceJson,
  runMutationOnceJsonLocked,
};
