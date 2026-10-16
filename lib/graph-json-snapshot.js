'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { withMutationJournalLock } = require('./mutation-journal-lock');
const { atomicWriteFileSync } = require('./graph-record-utils');
const { commitJsonTransaction, recoverJsonTransaction } = require('./graph-json-transaction');

function readOptional(file) {
  try { return fs.readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function revision(memory, embeddings) {
  const hash = bytes => bytes == null ? null : crypto.createHash('sha256').update(bytes).digest('hex');
  return JSON.stringify([hash(memory), hash(embeddings)]);
}

function diskRevision(graph) {
  return revision(readOptional(graph.memoryPath), readOptional(graph._embeddingPath));
}

function view(graph) {
  return JSON.stringify([graph._nodes, graph._edges, graph._candidateClaims, graph._auditEvents]);
}

function rememberSnapshot(graph, loadedRevision = diskRevision(graph)) {
  graph._jsonSnapshotRevision = loadedRevision;
  graph._jsonSnapshotView = view(graph);
}

function conflict() {
  const error = new Error('Graph JSON changed on disk; reload before retrying this write.');
  error.code = 'GRAPH_JSON_WRITE_CONFLICT';
  return error;
}

function changed(graph) {
  return diskRevision(graph) !== (graph._jsonSnapshotRevision ?? revision(null, null));
}

function refreshSnapshot(graph) {
  if (!changed(graph)) return;
  const priorView = graph._jsonSnapshotView ?? JSON.stringify([{}, [], [], []]);
  if (view(graph) !== priorView) throw conflict();
  graph.load();
}

/**
 * `faultHook` is the store's own fault-injection seam, threaded through from
 * the caller that owns it (see lib/graph-json-transaction.js, #2343).
 */
function withSnapshotLock(graph, callback, faultHook) {
  if (graph._jsonSnapshotLockHeld) return callback();
  return withMutationJournalLock(graph.jsonJournalPath(), () => {
    graph._jsonSnapshotLockHeld = true;
    try {
      recoverJsonTransaction(graph, faultHook);
      return callback();
    }
    finally { graph._jsonSnapshotLockHeld = false; }
  });
}

function saveSnapshot(graph, save, faultHook) {
  return withSnapshotLock(graph, () => {
    if (changed(graph)) throw conflict();
    save();
    rememberSnapshot(graph);
  }, faultHook);
}

function runSnapshotMutation(graph, mutate, faultHook) {
  if (graph._jsonSnapshotLockHeld) {
    const error = new Error('Nested JSON graph mutations are not supported.');
    error.code = 'GRAPH_JSON_NESTED_MUTATION';
    throw error;
  }
  return withSnapshotLock(graph, () => { refreshSnapshot(graph); return mutate(); }, faultHook);
}

function writeCurrentState(graph) {
  // Stripping embeddings mutates live records. Restore on every exit, including
  // disk failures, so a failed save never erases the only in-memory vectors.
  const embeddings = graph.stripEmbeddings();
  try { graph.writeStrippedState(embeddings); }
  finally { graph.restoreEmbeddings(embeddings); }
}

function writeJsonFiles(graph, embeddings) {
  const memory = JSON.stringify({ nodes: graph._nodes, edges: graph._edges,
    candidateClaims: graph._candidateClaims, auditEvents: graph._auditEvents });
  const previous = graph._db ? null : readOptional(graph.memoryPath);
  atomicWriteFileSync(graph.memoryPath, memory);
  try {
    writeEmbeddingSidecar(graph, embeddings);
  } catch (error) {
    if (!graph._db) {
      // This is a caught I/O failure, not process-crash recovery. Restore the
      // first file under the same lock so retry sees the original revision.
      try {
        if (!readOptional(graph.memoryPath)?.equals(Buffer.from(memory))) throw conflict();
        if (previous === null) fs.unlinkSync(graph.memoryPath);
        else atomicWriteFileSync(graph.memoryPath, previous);
      } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
}

// The embedding sidecar is written on every save -- including the incremental
// SQLite path -- because embeddings live only here, not in the node rows, so a
// skipped sidecar write would silently drop vectors. It is bounded by the
// embedding count, not the graph size.
function writeEmbeddingSidecar(graph, embeddings) {
  // Always replace the sidecar, including {}, to prevent deleted embeddings
  // being resurrected on the next load (#609).
  atomicWriteFileSync(graph._embeddingPath, JSON.stringify(embeddings));
}

module.exports = { commitJsonTransaction, revision, rememberSnapshot, runSnapshotMutation, saveSnapshot, writeCurrentState, writeJsonFiles, writeEmbeddingSidecar };
