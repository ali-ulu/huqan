'use strict';

const fs = require('fs');
const { normalizeAuditEvent } = require('./audit-log');

// Causal relation types for v0.7
const CAUSAL_RELATIONS = Object.freeze([
  'CAUSES',      // Neden olur
  'PREVENTS',    // Engelleyen
  'ENABLES',     // Mümkün kılan
  'DEPENDS_ON',  // Bağımlı olduğu
  'LEADS_TO',    // Sonuçlanan
]);

const STANDARD_RELATIONS = Object.freeze([
  'is_a',
  'has_property',
  'related_to',
  ...CAUSAL_RELATIONS,
]);

const EDGE_META_NAMESPACE = 'entityResolution';
const EDGE_META_MAX_BYTES = 4096;
const RECEIPT_FAMILY_MIGRATION_ERROR_CODE = 'RECEIPT_FAMILY_MIGRATION_FAILED';
const RECEIPT_FAMILIES = new Set(['v4', 'non-v4']);

const CAUSAL_RELATION_PRIORITY = Object.freeze({
  CAUSES: 0,
  ENABLES: 1,
  LEADS_TO: 2,
  DEPENDS_ON: 3,
  PREVENTS: 4,
});

/**
 * Writes `content` to `filePath` atomically: writes into a sibling temp
 * file in the same directory, then renames over the destination.
 * `fs.renameSync` within one directory is atomic, so a crash mid-write
 * (or a concurrent reader) never observes a partially-written/truncated
 * file — either the old content or the new content, never a torn mix.
 */
function atomicWriteFileSync(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function receiptFamilyMigrationError(cause) {
  const error = new Error('mutation receipt family migration failed');
  error.code = RECEIPT_FAMILY_MIGRATION_ERROR_CODE;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function normalizeWorkspaceId(value, fallback = 'default') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNodeRecord(node = {}, fallbackKey = '') {
  const workspaceId = normalizeWorkspaceId(node.workspaceId || node.workspace_id || 'default');
  const id = node.id || fallbackKey.split('::').pop() || '';
  const createdAt = node.created_at || (typeof node.created === 'number' ? new Date(node.created).toISOString() : '');
  const lastSeen = node.last_seen || node.lastSeen || createdAt || nowIso();
  return {
    ...node,
    id,
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

function clamp01(value, fallback = 0.5) {
  const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : 0.5;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, fallbackNumber));
  return Math.max(0, Math.min(1, numeric));
}

function edgeSortKey(edge) {
  return [
    edge.from || '',
    edge.to || '',
    edge.relation || '',
    edge.source_ref || '',
    edge.session_id || '',
    edge.created_at || '',
    String(edge.created || ''),
  ].join('|');
}

function compareCausalEdges(a, b) {
  const relationPriorityDiff =
    (CAUSAL_RELATION_PRIORITY[a.relation] ?? 99) -
    (CAUSAL_RELATION_PRIORITY[b.relation] ?? 99);
  if (relationPriorityDiff !== 0) return relationPriorityDiff;

  const strengthDiff = (b.strength ?? 0.5) - (a.strength ?? 0.5);
  if (strengthDiff !== 0) return strengthDiff;

  const confidenceDiff = (b.confidence ?? 0.5) - (a.confidence ?? 0.5);
  if (confidenceDiff !== 0) return confidenceDiff;

  const createdAtDiff = String(a.created_at || '').localeCompare(String(b.created_at || ''));
  if (createdAtDiff !== 0) return createdAtDiff;

  return edgeSortKey(a).localeCompare(edgeSortKey(b));
}

function normalizeCausalStep(edge) {
  const step = {
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    strength: edge.strength ?? 0.5,
    confidence: edge.confidence ?? edge.weight ?? 0.5,
    source: edge.source || 'manual',
    source_ref: edge.source_ref || '',
    session_id: edge.session_id || '',
    evidence: Array.isArray(edge.evidence) ? edge.evidence : [],
    evidence_type: edge.evidence_type || '',
    created_at: edge.created_at || '',
    updated_at: edge.updated_at || '',
  };

  if (typeof edge.created === 'number') {
    step.created = edge.created;
  }

  return step;
}

function sanitizeEdgeMeta(meta) {
  if (!isPlainObject(meta)) return {};
  const candidate = {};
  if (Object.prototype.hasOwnProperty.call(meta, EDGE_META_NAMESPACE) && isPlainObject(meta[EDGE_META_NAMESPACE])) {
    try {
      candidate[EDGE_META_NAMESPACE] = JSON.parse(JSON.stringify(meta[EDGE_META_NAMESPACE]));
      const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
      if (bytes > EDGE_META_MAX_BYTES) return {};
      return candidate;
    } catch (_) {
      return {};
    }
  }
  return {};
}

/**
 * Return a causal chain together with its traversal metadata.
 *
 * #401 — the chain array used to carry a `.chain` property pointing at
 * itself, turning the returned value into a circular structure. Any caller
 * that serialized it (e.g. CausalSimulator puts the traversal into its
 * result, and kernel/server callers JSON-encode that) died with
 * "Converting circular structure to JSON". The metadata is now a plain
 * object whose `chain` holds the array, so the result is JSON-safe while
 * keeping the same property surface (`traversal.chain` / `.start` / etc.).
 */
function attachTraversalMeta(chain, meta) {
  return {
    chain,
    start: meta.start,
    visited: meta.visited,
    loops: meta.loops,
    stoppedReason: meta.stoppedReason,
    maxDepth: meta.maxDepth,
    confidence: meta.confidence,
  };
}

function normalizeLoadedEdge(edge) {
  const normalized = {
    ...edge,
    weight: clamp01(edge.weight, 0.5),
    confidence: clamp01(edge.confidence, clamp01(edge.weight, 0.5)),
    source: edge.source || 'manual',
    source_ref: edge.source_ref || '',
    session_id: edge.session_id || '',
    evidence: Array.isArray(edge.evidence) ? edge.evidence : [],
    evidence_type: edge.evidence_type || '',
    confidence_history: Array.isArray(edge.confidence_history) ? edge.confidence_history : [],
    company_mode: Number(edge.company_mode || 0),
    source_type: edge.source_type || '',
    updated_at: edge.updated_at || '',
    created_at: edge.created_at || '',
    provenance: deepClone(edge.provenance),
    meta: sanitizeEdgeMeta(edge.meta),
    workspaceId: edge.workspaceId || edge.workspace_id || 'default',
  };

  if (CAUSAL_RELATIONS.includes(normalized.relation)) {
    normalized.strength = typeof normalized.strength === 'number' ? normalized.strength : 0.5;
  } else if ('strength' in normalized) {
    delete normalized.strength;
  }

  return normalized;
}

function cloneAuditEvent(event) {
  return normalizeAuditEvent({
    auditId: event.auditId,
    eventType: event.eventType,
    targetType: event.targetType,
    targetId: event.targetId,
    workspaceId: event.workspaceId,
    actor: event.actor,
    timestamp: event.timestamp,
    sourceRef: event.sourceRef,
    provenanceId: event.provenanceId,
    trustPolicyVersion: event.trustPolicyVersion,
    details: event.details,
  });
}

/**
 * The bound-parameter list for the shared `updateEdgeWeight` statement.
 *
 * Three places wrote an edge row and each built its own column list: this
 * statement had two hand-written argument lists (graph.js's `persistUpdate`
 * and graph-edge-mutations.js's `persistEdgeUpdate`), and `_writeStrippedState`
 * inlined a second UPSERT beside the prepared one. They drifted, and what fell
 * through the gap was `strength`: written on create, absent from the update
 * statement entirely. Lowering a causal edge's strength changed only the
 * in-memory edge, the row kept the creation value, and every reload decided on
 * it — while verify.js reads exactly this field first (#1024).
 *
 * One builder is what keeps the next column from being added to only some of
 * the callers.
 */
function edgeUpdateArgs(edge, workspaceId, fromId, toId, relation, isoNow) {
  return [
    edge.weight,
    edge.confidence,
    edge.source || 'manual',
    edge.source_ref || '',
    edge.session_id || '',
    JSON.stringify(edge.evidence || []),
    edge.evidence_type || '',
    JSON.stringify(edge.confidence_history || []),
    edge.company_mode ? 1 : 0,
    edge.source_type || '',
    edge.updated_at || isoNow,
    JSON.stringify(edge.provenance ?? null),
    JSON.stringify(edge.meta ?? {}),
    // Matches what persistCreate writes, so a non-causal edge keeps the value
    // its row already holds rather than being cleared by an update.
    edge.strength ?? 0.5,
    workspaceId,
    // The WHERE key follows the SET list.
    workspaceId,
    fromId,
    toId,
    relation,
  ];
}

module.exports = {
  CAUSAL_RELATIONS,
  STANDARD_RELATIONS,
  EDGE_META_NAMESPACE,
  EDGE_META_MAX_BYTES,
  RECEIPT_FAMILY_MIGRATION_ERROR_CODE,
  RECEIPT_FAMILIES,
  CAUSAL_RELATION_PRIORITY,
  atomicWriteFileSync,
  receiptFamilyMigrationError,
  normalizeWorkspaceId,
  nodeStorageKey,
  edgeIndexKey,
  nowIso,
  deepClone,
  isPlainObject,
  normalizeNodeRecord,
  cloneNodeMap,
  cloneNodeRecord,
  cloneEdgeRecord,
  clamp01,
  edgeSortKey,
  compareCausalEdges,
  normalizeCausalStep,
  sanitizeEdgeMeta,
  attachTraversalMeta,
  normalizeLoadedEdge,
  cloneAuditEvent,
  edgeUpdateArgs,
};
