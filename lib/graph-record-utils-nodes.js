'use strict';

// #2216: node and edge storage keys, and the normalization and cloning of
// node, node map and edge records.

const { normalizeWorkspaceId } = require('./workspace-id');
const { isPlainObject } = require('./is-plain-object');

function nodeStorageKey(id, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  return scope === 'default' ? id : `${scope}::${id}`;
}

function edgeIndexKey(id, workspaceId = 'default') {
  return nodeStorageKey(id, workspaceId);
}

function nowIso() {
  return new Date().toISOString();
}

function deepClone(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}


/**
 * The one place a node's label is decided.
 *
 * `addNode(id, label)` validated nothing, so the two backends answered the
 * same input differently: `nodes.label` is NOT NULL, so SQLite threw a raw
 * `SqliteError` straight through Graph and Kernel — outside the AXIOM_ERROR
 * envelope contract — while the JSON backend accepted the write and stored a
 * record with no `label` key at all. Since graph.js falls back to JSON
 * silently when better-sqlite3 will not load, the same code on the same input
 * threw on one machine and succeeded on another (#1027).
 *
 * Defaulting to the id rather than throwing matches what `proposeNode`
 * already assumes with its `label || id`, and keeps existing callers working.
 */
function normalizeNodeLabel(label, id) {
  return typeof label === 'string' && label.trim() ? label : String(id ?? '');
}

function normalizeNodeRecord(node = {}, fallbackKey = '') {
  const workspaceId = normalizeWorkspaceId(node.workspaceId || node.workspace_id || 'default');
  const id = node.id || fallbackKey.split('::').pop() || '';
  const createdAt = node.created_at || (typeof node.created === 'number' ? new Date(node.created).toISOString() : '');
  const lastSeen = node.last_seen || node.lastSeen || createdAt || nowIso();
  return {
    ...node,
    id,
    // Repairs a label-less record written by the JSON backend before the write
    // path normalized. Without this, load()'s `if (this._db && ...) this.save()`
    // migration hits the NOT NULL constraint far from where the record was
    // produced (#1027).
    label: normalizeNodeLabel(node.label, id),
    workspaceId,
    created_at: createdAt,
    last_seen: lastSeen,
    lastSeen,
    provenance: deepClone(node.provenance),
    vector: isPlainObject(node.vector) ? deepClone(node.vector) : {},
    tags: Array.isArray(node.tags) ? [...node.tags] : [],
  };
}

/**
 * Snapshot clone for the node map, used by the mutation-rollback paths.
 *
 * #369: deepClone() is a JSON round-trip, and JSON has no typed arrays --
 * a Float64Array embedding comes back as a plain `{"0":0.5,"1":0.25}` object.
 * That object is still *truthy*, so every `if (node.embedding)` guard keeps
 * passing while `.length` is undefined; dream.js's nodeSimilarity() then
 * iterates zero times and scores every pair 0.0 instead of erroring. Rolling
 * back a failed mutation must not quietly downgrade embeddings into that
 * shape, so they are copied out as real typed arrays here.
 */
function cloneNodeMap(nodes) {
  const cloned = {};
  for (const [key, node] of Object.entries(nodes || {})) {
    if (!node) {
      cloned[key] = node;
      continue;
    }
    const { embedding, ...rest } = node;
    const copy = deepClone(rest);
    if (embedding) copy.embedding = Float64Array.from(embedding);
    cloned[key] = copy;
  }
  return cloned;
}

function cloneNodeRecord(node) {
  if (!node) return null;
  return {
    ...node,
    tags: Array.isArray(node.tags) ? [...node.tags] : [],
    vector: isPlainObject(node.vector) ? deepClone(node.vector) : {},
    provenance: deepClone(node.provenance),
  };
}

function cloneEdgeRecord(edge) {
  if (!edge) return null;
  return {
    ...edge,
    evidence: Array.isArray(edge.evidence) ? [...edge.evidence] : [],
    confidence_history: Array.isArray(edge.confidence_history) ? deepClone(edge.confidence_history) : [],
    provenance: deepClone(edge.provenance),
    meta: deepClone(edge.meta) ?? {},
  };
}

module.exports = {
  cloneEdgeRecord,
  cloneNodeRecord,
  deepClone,
  edgeIndexKey,
  nodeStorageKey,
  normalizeNodeLabel,
  normalizeNodeRecord,
  nowIso,
};
