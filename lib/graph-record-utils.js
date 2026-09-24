'use strict';

// Graph record helpers: the atomic write, loaded-edge normalization, audit
// event cloning and edge update arguments. Relations and edge ordering live in
// graph-record-utils-edges.js, node records in graph-record-utils-nodes.js (#2216).

const fs = require('fs');
const { normalizeAuditEvent } = require('./audit-log');
const { normalizeWorkspaceId } = require('./workspace-id');
const { isPlainObject } = require('./is-plain-object');
const { CAUSAL_RELATIONS, CAUSAL_RELATION_PRIORITY, EDGE_META_MAX_BYTES, EDGE_META_NAMESPACE, RECEIPT_FAMILIES, RECEIPT_FAMILY_MIGRATION_ERROR_CODE, STANDARD_RELATIONS, attachTraversalMeta, clamp01, compareCausalEdges, edgeSortKey, normalizeCausalStep, sanitizeEdgeMeta } = require('./graph-record-utils-edges');
const { cloneEdgeRecord, cloneNodeRecord, deepClone, edgeIndexKey, nodeStorageKey, normalizeNodeLabel, normalizeNodeRecord, nowIso } = require('./graph-record-utils-nodes');

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
 * and graph-edge-mutations.js's `persistEdgeUpdate`), and `writeStrippedState`
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
  normalizeNodeLabel,
  normalizeNodeRecord,
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
