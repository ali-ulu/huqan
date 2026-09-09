'use strict';

const fs = require('node:fs');
const { isPlainObject, normalizeNodeRecord, normalizeLoadedEdge, nodeStorageKey } = require('./graph-record-utils');
const { normalizeCandidateClaim } = require('./conflict-detector');
const { normalizeAuditEvent } = require('./audit-log');
const { revision, rememberSnapshot } = require('./graph-json-snapshot');

function assertGraphPersistenceWritable(graph) {
  if (graph._persistenceLoadError) throw graph._persistenceLoadError;
}

function records(value, name) {
  if (!Array.isArray(value) || value.some(record => !isPlainObject(record))) {
    throw new TypeError(`invalid graph ${name}`);
  }
  return value;
}

// #1984: corrupt embedding files used to vanish inside catch(_){} on the
// JSON path while the SQLite path threw SQLITE_PERSISTENCE_LOAD_FAILED for
// the same file. Count every ignored embedding load and surface it on the
// graph instance so load() callers can tell "no embeddings" apart from
// "embeddings were corrupt and skipped".
let embeddingLoadFailures = 0;

function getEmbeddingLoadFailures() {
  return embeddingLoadFailures;
}

function noteEmbeddingLoadFailure(graph, error) {
  embeddingLoadFailures += 1;
  if (graph) {
    graph._embeddingsIgnored = true;
    graph._embeddingLoadError = (error && error.message) || String(error);
  }
  return embeddingLoadFailures;
}

function loadEmbeddingsLenient(graph) {
  // Shared by the JSON and SQLite load paths (#1984). A corrupt embedding
  // sidecar must never fail the whole load nor vanish silently: count it,
  // flag it on the graph, and let the caller continue with the graph data.
  // Preserve the bytes read even when parsing fails (#2033): the JSON snapshot
  // must match the file on disk, not treat a corrupt sidecar as an absent one.
  graph._embeddingsIgnored = false;
  graph._embeddingLoadError = null;
  if (!fs.existsSync(graph._embeddingPath)) return undefined;
  let bytes;
  try {
    bytes = fs.readFileSync(graph._embeddingPath);
    graph._restoreEmbeddings(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    noteEmbeddingLoadFailure(graph, error);
  }
  return bytes;
}
function parseGraphState(text) {
  const data = JSON.parse(text);
  if (!isPlainObject(data) || !isPlainObject(data.nodes)) throw new TypeError('invalid graph nodes');
  const nodes = {};
  for (const [key, node] of Object.entries(data.nodes)) {
    if (!isPlainObject(node)) throw new TypeError('invalid graph node');
    const normalized = normalizeNodeRecord(node, key);
    if (typeof normalized.id !== 'string' || !normalized.id) throw new TypeError('invalid graph node id');
    const storageKey = nodeStorageKey(normalized.id, normalized.workspaceId);
    if (Object.hasOwn(nodes, storageKey)) throw new TypeError('duplicate graph node identity');
    Object.defineProperty(nodes, storageKey, {
      value: normalized, enumerable: true, writable: true, configurable: true,
    });
  }
  const edges = records(data.edges === undefined ? [] : data.edges, 'edges').map(edge => {
    if (['from', 'to', 'relation'].some(key => typeof edge[key] !== 'string' || !edge[key])) {
      throw new TypeError('invalid graph edge');
    }
    return normalizeLoadedEdge(edge);
  });
  const candidates = records(data.candidateClaims !== undefined ? data.candidateClaims :
    data.candidate_claims !== undefined ? data.candidate_claims : [], 'candidate claims').map(candidate => normalizeCandidateClaim(candidate));
  const audits = records(data.auditEvents !== undefined ? data.auditEvents :
    data.audit_log !== undefined ? data.audit_log : [], 'audit events').map(event => normalizeAuditEvent(event));
  return { nodes, edges, candidates, audits };
}

function loadJsonGraph(graph) {
  let state;
  let text;
  try {
    try { text = fs.readFileSync(graph.memoryPath, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Deleting a corrupt file is not a successful recovery of this instance.
      assertGraphPersistenceWritable(graph);
    }
    state = text === undefined ? { nodes: {}, edges: [], candidates: [], audits: [] } : parseGraphState(text);
  } catch (cause) {
    const error = new Error('Graph JSON persistence load failed; restore a valid graph before writing.');
    error.code = 'GRAPH_JSON_LOAD_FAILED';
    error.causeCode = cause.code || 'INVALID_GRAPH_JSON';
    graph._persistenceLoadError = error;
    throw error;
  }

  // Publish only a completely parsed/normalized snapshot. Failed reloads retain
  // the prior in-memory view, but writes stay blocked until a valid reload.
  graph._nodes = state.nodes;
  graph._edges = state.edges;
  graph._candidateClaims = state.candidates;
  graph._auditEvents = state.audits;
  graph._rebuildIndex();
  graph._persistenceLoadError = null;

  const embeddingText = loadEmbeddingsLenient(graph);
  if (!graph._db) rememberSnapshot(graph, revision(text, embeddingText));
  // Preserve the legacy JSON-to-SQLite import path, after validation succeeds.
  if (graph._db && Object.keys(graph._nodes).length > 0) graph.save();
}

module.exports = {
  assertGraphPersistenceWritable,
  getEmbeddingLoadFailures,
  loadEmbeddingsLenient,
  loadJsonGraph,
  noteEmbeddingLoadFailure,
};
