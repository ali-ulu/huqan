'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { atomicWriteFileSync } = require('./graph-record-utils');

const VERSION = 1;

function redoPathFor(journalPath) { return `${journalPath}.redo.json`; }

function readOptional(filePath) {
  try { return fs.readFileSync(filePath); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function hash(bytes) {
  return bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex');
}

function recoveryError(message, redoPath, code = 'GRAPH_JSON_RECOVERY_FAILED') {
  const error = new Error(message);
  error.code = code;
  error.redoPath = redoPath;
  return error;
}

function canonicalBase64(value, redoPath) {
  if (typeof value !== 'string') throw recoveryError('JSON recovery after-image is invalid', redoPath);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw recoveryError('JSON recovery after-image is not canonical base64', redoPath);
  return bytes;
}

function validateRedo(record, redoPath) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.version !== VERSION || typeof record.operationId !== 'string' || !record.operationId ||
      typeof record.createdAt !== 'string' || !record.files || typeof record.files !== 'object') {
    throw recoveryError('JSON recovery record has an invalid envelope', redoPath);
  }
  if (Object.keys(record).sort().join(',') !== 'createdAt,files,operationId,version' ||
      Object.keys(record.files).sort().join(',') !== 'embeddings,journal,memory') {
    throw recoveryError('JSON recovery record has unknown or missing fields', redoPath);
  }
  const files = {};
  for (const name of ['memory', 'embeddings', 'journal']) {
    const entry = record.files[name];
    if (!entry || typeof entry !== 'object' ||
        Object.keys(entry).sort().join(',') !== 'after,afterHash,beforeHash,path' ||
        typeof entry.path !== 'string' || !entry.path ||
        !(entry.beforeHash === null || /^[a-f0-9]{64}$/.test(entry.beforeHash)) ||
        !/^[a-f0-9]{64}$/.test(entry.afterHash)) {
      throw recoveryError(`JSON recovery ${name} entry is invalid`, redoPath);
    }
    const after = canonicalBase64(entry.after, redoPath);
    if (hash(after) !== entry.afterHash) throw recoveryError(`JSON recovery ${name} after-image hash mismatch`, redoPath);
    files[name] = { ...entry, after };
  }
  return { operationId: record.operationId, files };
}

function readRedo(redoPath) {
  let raw;
  try { raw = fs.readFileSync(redoPath, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  let record;
  try { record = JSON.parse(raw); }
  catch (_) { throw recoveryError('JSON recovery record is not valid JSON', redoPath); }
  return validateRedo(record, redoPath);
}

function fault(graph, point) {
  if (typeof graph._jsonTransactionFault === 'function') graph._jsonTransactionFault(point);
}

function assertRedoPaths(graph, redo, redoPath) {
  const expected = {
    memory: graph.memoryPath,
    embeddings: graph._embeddingPath,
    journal: graph._jsonJournalPath(),
  };
  for (const name of Object.keys(expected)) {
    if (redo.files[name].path !== expected[name]) {
      throw recoveryError(`JSON recovery ${name} path does not match this store`, redoPath, 'GRAPH_JSON_RECOVERY_CONFLICT');
    }
  }
}

function publish(entry, redoPath) {
  const currentHash = hash(readOptional(entry.path));
  if (currentHash === entry.afterHash) return;
  if (currentHash !== entry.beforeHash) {
    throw recoveryError('JSON recovery found an unexpected current-file hash', redoPath, 'GRAPH_JSON_RECOVERY_CONFLICT');
  }
  atomicWriteFileSync(entry.path, entry.after);
}

function recoverJsonTransaction(graph) {
  const redoPath = redoPathFor(graph._jsonJournalPath());
  const redo = readRedo(redoPath);
  if (!redo) return false;
  assertRedoPaths(graph, redo, redoPath);
  publish(redo.files.memory, redoPath);
  publish(redo.files.embeddings, redoPath);
  publish(redo.files.journal, redoPath);
  fault(graph, 'before-recovery-cleanup');
  fs.unlinkSync(redoPath);
  return true;
}

function serializeGraph(graph) {
  const embeddings = graph._stripEmbeddings();
  try {
    return {
      memory: Buffer.from(JSON.stringify({
        nodes: graph._nodes,
        edges: graph._edges,
        candidateClaims: graph._candidateClaims,
        auditEvents: graph._auditEvents,
      })),
      embeddings: Buffer.from(JSON.stringify(embeddings)),
    };
  } finally {
    graph._restoreEmbeddings(embeddings);
  }
}

function entry(path, before, after) {
  return { path, beforeHash: hash(before), afterHash: hash(after), after: after.toString('base64') };
}

function commitJsonTransaction(graph, operationId, journal) {
  const journalPath = graph._jsonJournalPath();
  const redoPath = redoPathFor(journalPath);
  if (fs.existsSync(redoPath)) throw recoveryError('pending JSON recovery must be completed before commit', redoPath);
  const state = serializeGraph(graph);
  const journalAfter = Buffer.from(JSON.stringify(journal));
  const record = {
    version: VERSION,
    operationId,
    createdAt: new Date().toISOString(),
    files: {
      memory: entry(graph.memoryPath, readOptional(graph.memoryPath), state.memory),
      embeddings: entry(graph._embeddingPath, readOptional(graph._embeddingPath), state.embeddings),
      journal: entry(journalPath, readOptional(journalPath), journalAfter),
    },
  };

  fault(graph, 'before-prepared');
  atomicWriteFileSync(redoPath, JSON.stringify(record));
  fault(graph, 'after-prepared');
  publish(validateRedo(record, redoPath).files.memory, redoPath);
  fault(graph, 'after-graph-publish');
  publish(validateRedo(record, redoPath).files.embeddings, redoPath);
  fault(graph, 'after-embedding-publish');
  publish(validateRedo(record, redoPath).files.journal, redoPath);
  fault(graph, 'after-journal-publish');
  fs.unlinkSync(redoPath);
}

module.exports = { commitJsonTransaction, recoverJsonTransaction, redoPathFor };
