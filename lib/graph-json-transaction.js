'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { atomicWriteFileSync } = require('./graph-record-utils');

// 1 embedded the after-images as base64 in the record; 2 stages them next to
// the target files and keeps only their hashes here, which halves the bytes a
// commit writes. Both are readable so a redo written by 1 still recovers.
const VERSION = 2;
const READABLE_VERSIONS = new Set([1, 2]);

function stagedPathFor(targetPath) { return `${targetPath}.staged`; }

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

function validateEntry(name, entry, expectedFields, redoPath) {
  if (!entry || typeof entry !== 'object' ||
      Object.keys(entry).sort().join(',') !== expectedFields ||
      typeof entry.path !== 'string' || !entry.path ||
      !(entry.beforeHash === null || /^[a-f0-9]{64}$/.test(entry.beforeHash)) ||
      !/^[a-f0-9]{64}$/.test(entry.afterHash)) {
    throw recoveryError(`JSON recovery ${name} entry is invalid`, redoPath);
  }
  return entry;
}

function validateRedo(record, redoPath) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !READABLE_VERSIONS.has(record.version) || typeof record.operationId !== 'string' || !record.operationId ||
      typeof record.createdAt !== 'string' || !record.files || typeof record.files !== 'object') {
    throw recoveryError('JSON recovery record has an invalid envelope', redoPath);
  }
  if (Object.keys(record).sort().join(',') !== 'createdAt,files,operationId,version' ||
      Object.keys(record.files).sort().join(',') !== 'embeddings,journal,memory') {
    throw recoveryError('JSON recovery record has unknown or missing fields', redoPath);
  }
  const files = {};
  for (const name of ['memory', 'embeddings', 'journal']) {
    const entry = record.version === 1
      ? validateEntry(name, record.files[name], 'after,afterHash,beforeHash,path', redoPath)
      : validateEntry(name, record.files[name], 'afterHash,beforeHash,path,staged', redoPath);
    if (record.version === 1) {
      const after = canonicalBase64(entry.after, redoPath);
      if (hash(after) !== entry.afterHash) throw recoveryError(`JSON recovery ${name} after-image hash mismatch`, redoPath);
      files[name] = { ...entry, after };
      continue;
    }
    if (entry.staged !== stagedPathFor(entry.path)) {
      throw recoveryError(`JSON recovery ${name} staged after-image path does not match its target`, redoPath, 'GRAPH_JSON_RECOVERY_CONFLICT');
    }
    files[name] = entry;
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

/**
 * Fault injection is a test affordance the store owns. It arrives through the
 * commit/recovery entry points instead of being read off the store here, so
 * this module holds no private member of the object it is handed (#2343).
 */
function fault(faultHook, point) {
  if (typeof faultHook === 'function') faultHook(point);
}

function assertRedoPaths(graph, redo, redoPath) {
  const expected = {
    memory: graph.memoryPath,
    embeddings: graph._embeddingPath,
    journal: graph.jsonJournalPath(),
  };
  for (const name of Object.keys(expected)) {
    if (redo.files[name].path !== expected[name]) {
      throw recoveryError(`JSON recovery ${name} path does not match this store`, redoPath, 'GRAPH_JSON_RECOVERY_CONFLICT');
    }
  }
}

function publishEntry(entry, redoPath, verifyAfterImage) {
  const currentHash = hash(readOptional(entry.path));
  if (currentHash === entry.afterHash) {
    discardStaged(entry);
    return;
  }
  if (currentHash !== entry.beforeHash) {
    throw recoveryError('JSON recovery found an unexpected current-file hash', redoPath, 'GRAPH_JSON_RECOVERY_CONFLICT');
  }
  if (entry.after) {
    atomicWriteFileSync(entry.path, entry.after);
    return;
  }
  // Only recovery reads the staged bytes back: the commit wrote them from the
  // buffer it hashed, so the record cannot disagree with the file it just made.
  if (verifyAfterImage && hash(readOptional(entry.staged)) !== entry.afterHash) {
    throw recoveryError('JSON recovery after-image is missing or does not match its record', redoPath, 'GRAPH_JSON_RECOVERY_CONFLICT');
  }
  fs.renameSync(entry.staged, entry.path);
}

function publish(entry, redoPath) { return publishEntry(entry, redoPath, true); }
function publishStaged(entry, redoPath) { return publishEntry(entry, redoPath, false); }

function discardStaged(entry) {
  if (!entry.staged) return;
  try { fs.unlinkSync(entry.staged); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

/** No record means no recovery, so the staged copies must not outlive it. */
function discardStagedFiles(files) {
  for (const entry of Object.values(files)) discardStaged(entry);
}

function recoverJsonTransaction(graph, faultHook) {
  const redoPath = redoPathFor(graph.jsonJournalPath());
  const redo = readRedo(redoPath);
  if (!redo) return false;
  assertRedoPaths(graph, redo, redoPath);
  publish(redo.files.memory, redoPath);
  publish(redo.files.embeddings, redoPath);
  publish(redo.files.journal, redoPath);
  fault(faultHook, 'before-recovery-cleanup');
  fs.unlinkSync(redoPath);
  return true;
}

function serializeGraph(graph) {
  const embeddings = graph.stripEmbeddings();
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
    graph.restoreEmbeddings(embeddings);
  }
}

function entry(path, beforeHash, after) {
  // The staged file is written atomically, so a crash leaves either no staged
  // file or a complete one; publish() only has to rename it into place.
  const staged = stagedPathFor(path);
  atomicWriteFileSync(staged, after);
  return { path, beforeHash, afterHash: hash(after), staged };
}

/**
 * The before-image hash of a file the transaction is about to replace.
 *
 * `known` carries the hashes the caller already holds for the current disk
 * revision (see snapshotHashes in graph-json-snapshot.js). A caller that does
 * not hold them gets the old behaviour: read the file and hash it. The value is
 * only trusted for the hash field -- publish() re-reads each file and refuses
 * one whose hash does not match -- so a supplied hash cannot skip the conflict
 * check, it only skips a redundant read (#4636).
 */
function beforeImageHash(path, supplied) {
  if (typeof supplied === 'string') return supplied;
  return hash(readOptional(path));
}

function commitJsonTransaction(graph, operationId, journal, faultHook, knownBeforeHashes) {
  const journalPath = graph.jsonJournalPath();
  const redoPath = redoPathFor(journalPath);
  if (fs.existsSync(redoPath)) throw recoveryError('pending JSON recovery must be completed before commit', redoPath);
  const known = knownBeforeHashes && typeof knownBeforeHashes === 'object' ? knownBeforeHashes : {};
  const state = serializeGraph(graph);
  const journalAfter = Buffer.from(JSON.stringify(journal));
  const files = {};
  let validated;
  try {
    files.memory = entry(graph.memoryPath, beforeImageHash(graph.memoryPath, known.memory), state.memory);
    files.embeddings = entry(graph._embeddingPath, beforeImageHash(graph._embeddingPath, known.embeddings), state.embeddings);
    files.journal = entry(journalPath, beforeImageHash(journalPath, known.journal), journalAfter);
    const record = { version: VERSION, operationId, createdAt: new Date().toISOString(), files };
    // Validate once, before anything reaches disk. The record is a local object
    // that nothing mutates between the publishes, so re-validating it per file
    // only re-decoded and re-hashed the whole state three times (#perf).
    validated = validateRedo(record, redoPath);
    fault(faultHook, 'before-prepared');
    atomicWriteFileSync(redoPath, JSON.stringify(record));
  } catch (error) {
    // A staged copy only has a purpose under a record that names it, so a
    // failure on the way to that record must not leave one behind.
    discardStagedFiles(files);
    throw error;
  }
  fault(faultHook, 'after-prepared');
  try {
    publishStaged(validated.files.memory, redoPath);
  } catch (error) {
    // The first publish writes nothing when the file on disk is neither the
    // before- nor the after-image. Such a record can never be replayed and
    // would block every later commit, so the rejected transaction drops it.
    // A failed write of any other kind keeps the record for recovery.
    if (error.code === 'GRAPH_JSON_RECOVERY_CONFLICT') {
      discardStagedFiles(validated.files);
      fs.unlinkSync(redoPath);
    }
    throw error;
  }
  fault(faultHook, 'after-graph-publish');
  publishStaged(validated.files.embeddings, redoPath);
  fault(faultHook, 'after-embedding-publish');
  publishStaged(validated.files.journal, redoPath);
  fault(faultHook, 'after-journal-publish');
  fs.unlinkSync(redoPath);
  // The bytes just published are the ones on disk under the snapshot lock, so
  // their hashes are the disk revision. Returning it lets the caller record the
  // snapshot without reading and re-hashing both files again.
  return { revision: JSON.stringify([validated.files.memory.afterHash, validated.files.embeddings.afterHash]) };
}

module.exports = { commitJsonTransaction, recoverJsonTransaction, redoPathFor };
