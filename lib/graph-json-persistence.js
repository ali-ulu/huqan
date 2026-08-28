'use strict';

const fs = require('node:fs');
const { isPlainObject, normalizeNodeRecord, normalizeLoadedEdge, nodeStorageKey } = require('./graph-record-utils');
const { normalizeCandidateClaim } = require('./conflict-detector');
const { normalizeAuditEvent } = require('./audit-log');

function assertGraphPersistenceWritable(graph) {
  if (graph._persistenceLoadError) throw graph._persistenceLoadError;
}

function records(value, name) {
  if (!Array.isArray(value) || value.some(record => !isPlainObject(record))) {
    throw new TypeError(`invalid graph ${name}`);
  }
  return value;
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
  try {
    let text;
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

  if (fs.existsSync(graph._embeddingPath)) {
    try { graph._restoreEmbeddings(JSON.parse(fs.readFileSync(graph._embeddingPath, 'utf8'))); } catch (_) {}
  }
  // Preserve the legacy JSON-to-SQLite import path, after validation succeeds.
  if (graph._db && Object.keys(graph._nodes).length > 0) graph.save();
}

module.exports = { assertGraphPersistenceWritable, loadJsonGraph };
