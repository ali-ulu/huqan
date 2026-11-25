const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteFileSync, nowIso } = require('./graph-record-utils');
const { createMutationRollback } = require('./graph-mutation-rollback');
const {
  commitJsonTransaction,
  forgetSnapshot,
  rememberSnapshot,
  runSnapshotMutation,
  snapshotHashes,
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

/**
 * The parsed journal of a graph, keyed by the identity of the file it came from.
 *
 * Every writer publishes a new file, so any write -- this process's or another
 * one's -- changes the inode, the size or the mtime and the entry stops
 * matching. What that buys is the common case: a session that holds the lock and
 * mutates repeatedly no longer re-reads, re-parses and re-validates the whole
 * journal on every mutation, which grew with the number of past mutations
 * (#4655).
 */
const journalCache = new WeakMap();

function journalSignature(journalPath) {
  const stat = fs.statSync(journalPath, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}` : 'absent';
}

const hashBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * The parsed journal plus the hash of the bytes it was parsed from, so the next
 * commit can hand the transaction its before-image instead of reading and
 * hashing the whole file again. The hash is only trusted for the before-image
 * field: the transaction still verifies the file at publish time.
 */
function journalEntry(graph) {
  const journalPath = graph.jsonJournalPath();
  const signature = journalSignature(journalPath);
  const cached = journalCache.get(graph);
  if (cached && cached.signature === signature) return cached;
  const bytes = signature === 'absent' ? null : readOptionalBytes(journalPath);
  const journal = bytes === null
    ? readMutationJournal(journalPath)
    : readMutationJournal(journalPath, { existsSync: () => true, readFileSync: () => bytes.toString('utf8') });
  const entry = { signature, journal, hash: bytes === null ? null : hashBytes(bytes) };
  journalCache.set(graph, entry);
  return entry;
}

function readOptionalBytes(file) {
  try { return fs.readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; }
}

function readJsonJournal(graph) {
  return journalEntry(graph).journal;
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
  // The snapshot lock is already held and the graph has been refreshed, so this
  // is the authoritative journal for the whole mutation: nothing else writes it
  // while the lock is held, and `mutate()` touches graph state only. The
  // operation used to be read three times per mutation, re-parsing the same
  // bytes each time (#4636).
  const journalState = journalEntry(graph);
  const journal = journalState.journal;
  const prior = journal.operations[id];
  if (prior && prior.status === 'completed') {
    return {
      replayed: true,
      result: prior.result,
      receipt: readMutationReceiptFromJsonJournal(journal, id),
    };
  }

  const previousRollback = graph._mutationRollback;
  const rollback = createMutationRollback(graph);
  graph._mutationRollback = rollback;
  try {
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
    const committed = commitJsonTransaction(
      graph, id, journal, graph._jsonTransactionFault, { ...snapshotHashes(graph), journal: journalState.hash },
    );
    // The commit already knows the revision it published, so recording the
    // snapshot must not read and re-hash both files a second time.
    rememberSnapshot(graph, committed.revision);
    // The published journal is the object in hand, so the rest of this session
    // can reuse it. The lock is still held, so the signature cannot belong to
    // somebody else's write.
    journalCache.set(graph, {
      signature: journalSignature(graph.jsonJournalPath()),
      journal,
      hash: committed.journalHash,
    });
    return { replayed: false, result, receipt, persisted: true };
  } catch (error) {
    rollback.restore();
    // The journal in hand may hold entries the failed commit never published.
    journalCache.delete(graph);
    // Re-read: the failure may have landed after the journal was published, and
    // a completed entry means the caller's retry must not run the mutation again.
    const afterFailure = readJsonJournal(graph);
    const completed = afterFailure.operations[id];
    if (completed && completed.status === 'completed') {
      return {
        replayed: true,
        result: completed.result,
        receipt: readMutationReceiptFromJsonJournal(afterFailure, id),
      };
    }
    if (error.code === 'GRAPH_JSON_RECOVERY_CONFLICT') forgetSnapshot(graph);
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
