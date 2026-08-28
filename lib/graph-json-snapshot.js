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

function withSnapshotLock(graph, callback) {
  if (graph._jsonSnapshotLockHeld) return callback();
  return withMutationJournalLock(graph._jsonJournalPath(), () => {
    graph._jsonSnapshotLockHeld = true;
    try {
      recoverJsonTransaction(graph);
      return callback();
    }
    finally { graph._jsonSnapshotLockHeld = false; }
  });
}

function saveSnapshot(graph, save) {
  return withSnapshotLock(graph, () => {
    if (changed(graph)) throw conflict();
    save();
    rememberSnapshot(graph);
  });
}

function runSnapshotMutation(graph, mutate) {
  if (graph._jsonSnapshotLockHeld) {
    const error = new Error('Nested JSON graph mutations are not supported.');
    error.code = 'GRAPH_JSON_NESTED_MUTATION';
    throw error;
  }
  return withSnapshotLock(graph, () => { refreshSnapshot(graph); return mutate(); });
}

function writeCurrentState(graph) {
  // Stripping embeddings mutates live records. Restore on every exit, including
  // disk failures, so a failed save never erases the only in-memory vectors.
  const embeddings = graph._stripEmbeddings();
  try { graph._writeStrippedState(embeddings); }
  finally { graph._restoreEmbeddings(embeddings); }
}

function writeJsonFiles(graph, embeddings) {
  const memory = JSON.stringify({ nodes: graph._nodes, edges: graph._edges,
    candidateClaims: graph._candidateClaims, auditEvents: graph._auditEvents });
  const previous = graph._db ? null : readOptional(graph.memoryPath);
  atomicWriteFileSync(graph.memoryPath, memory);
  try {
    // Always replace the sidecar, including {}, to prevent deleted embeddings
    // being resurrected on the next load (#609).
    atomicWriteFileSync(graph._embeddingPath, JSON.stringify(embeddings));
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

module.exports = { commitJsonTransaction, revision, rememberSnapshot, runSnapshotMutation, saveSnapshot, writeCurrentState, writeJsonFiles };
