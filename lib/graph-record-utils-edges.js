'use strict';

// #2216: graph relation vocabularies, edge metadata and receipt family
// limits, and the deterministic causal edge ordering, steps and metadata.

const { isPlainObject } = require('./is-plain-object');

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

module.exports = {
  CAUSAL_RELATIONS,
  CAUSAL_RELATION_PRIORITY,
  EDGE_META_MAX_BYTES,
  EDGE_META_NAMESPACE,
  RECEIPT_FAMILIES,
  RECEIPT_FAMILY_MIGRATION_ERROR_CODE,
  STANDARD_RELATIONS,
  attachTraversalMeta,
  clamp01,
  compareCausalEdges,
  edgeSortKey,
  normalizeCausalStep,
  sanitizeEdgeMeta,
};
