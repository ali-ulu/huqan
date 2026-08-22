'use strict';

/**
 * Graph-owned edge mutations (issues #732, #733).
 *
 * Two separate bugs shared one root cause: code outside the Graph was deciding
 * what an edge should look like, without going through an API that keeps the
 * in-memory record, the indexes and the durable row in agreement.
 *
 *   #732 — lib/learn-use-case.js downgraded a contradicted `tür` edge by
 *          mutating the object returned from graph.getEdges(). That method
 *          returns cloneEdgeRecord() copies, so the write landed on a detached
 *          clone: the canonical edge kept its original weight while the emitted
 *          conflict text claimed it had been lowered. downgradeEdge() below is
 *          the missing write path; read APIs keep returning clones.
 *
 *   #733 — Graph._applyTemporalEdgeMetadata() walked every edge in the graph
 *          and stamped source/updatedAt/evidence on all of them, so one
 *          KernelV2.learn({source}) relabelled unrelated edges, including ones
 *          in other workspaces. applyTemporalEdgeMetadata() below only touches
 *          edges the operation actually created or updated.
 *
 * These take the Graph itself, because they are genuine graph writes — index
 * maintenance and persistence are the whole point. They live outside graph.js
 * only because that file is at the line-count ceiling recorded in
 * scripts/file-size-baseline.json.
 */

const {
  normalizeWorkspaceId,
  edgeIndexKey,
  clamp01,
  cloneEdgeRecord,
  nowIso,
  edgeUpdateArgs,
} = require('./graph-record-utils');

// NUL separates the key parts because it cannot occur in a workspace id or a
// node name, so no combination of parts can forge another key. It is written
// as an escape rather than as a raw byte: three raw NULs in the source made
// git treat this file as binary, so every change to it rendered as
// `Bin X -> Y bytes` with no line diff at all, and grep reported only
// "binary file matches" instead of the matching lines (#1042).
const KEY_SEPARATOR = '\u0000';

/**
 * Identity of an edge *including* its workspace.
 *
 * The old temporal-metadata key was `from|relation|to`, which collapses the
 * same triple in two workspaces into one entry. Anything deciding "did this
 * operation touch that edge?" has to keep the workspaces apart.
 */
function edgeTouchKey(workspaceId, from, relation, to) {
  return [normalizeWorkspaceId(workspaceId), from, relation, to].join(KEY_SEPARATOR);
}

function touchKeyOf(edge) {
  return edgeTouchKey(edge.workspaceId, edge.from, edge.relation, edge.to);
}

/**
 * Snapshot which edges already exist and open an empty set for the ones this
 * operation writes. `existing` is only used to tell "created" from "updated"
 * afterwards; it is never the thing that gets stamped.
 */
function beginEdgeTouchScope(graph) {
  return {
    touched: new Set(),
    existing: new Set(graph._edges.map(touchKeyOf)),
  };
}

/**
 * Stamp temporal/provenance metadata on exactly the edges this operation
 * created or updated.
 *
 * @param {object} graph
 * @param {object} options
 * @param {string} options.source        provenance label to record
 * @param {string} options.learnedAt     ISO timestamp for the operation
 * @param {object} options.scope         the touch scope from beginEdgeTouchScope()
 * @param {string} [options.workspaceId] when given, restricts the stamp to
 *   that workspace even if the operation somehow touched another
 * @returns {number} how many edges were stamped
 */
function applyTemporalEdgeMetadata(graph, options = {}) {
  const { source, scope } = options;
  const timestamp = options.learnedAt || nowIso();
  const touched = scope?.touched instanceof Set ? scope.touched : new Set();
  const existingBefore = scope?.existing instanceof Set ? scope.existing : new Set();
  const created = new Set([...touched].filter((key) => !existingBefore.has(key)));
  if (touched.size === 0) return 0;
  const workspaceScope = options.workspaceId ? normalizeWorkspaceId(options.workspaceId) : null;

  let stamped = 0;
  for (const edge of graph._edges) {
    const key = touchKeyOf(edge);
    if (!touched.has(key)) continue;
    if (workspaceScope && normalizeWorkspaceId(edge.workspaceId) !== workspaceScope) continue;

    if (created.has(key) && !edge.createdAt) edge.createdAt = timestamp;
    edge.updatedAt = timestamp;
    if (source) edge.source = source;

    if (!Array.isArray(edge.evidence)) edge.evidence = [];
    if (source && !edge.evidence.includes(`source:${source}`)) {
      edge.evidence.push(`source:${source}`);
    }
    stamped += 1;
  }
  return stamped;
}

function findLiveEdge(graph, fromId, toId, relation, workspaceId) {
  const out = graph._outIndex.get(edgeIndexKey(fromId, workspaceId)) || [];
  return out.find((edge) => edge.to === toId
    && edge.relation === relation
    && normalizeWorkspaceId(edge.workspaceId) === workspaceId) || null;
}

function persistEdgeUpdate(graph, edge, workspaceId) {
  if (!graph._db || !graph._stmts) return;
  // Shares the argument builder with graph.js's persistUpdate. This copy was
  // the reason the downgrade path silently dropped `strength` too (#1024).
  graph._stmts.updateEdgeWeight.run(
    ...edgeUpdateArgs(edge, workspaceId, edge.from, edge.to, edge.relation, nowIso()),
  );
}

function applyDowngradeFields(edge, spec) {
  if (Number.isFinite(spec.weight)) {
    edge.weight = clamp01(spec.weight, edge.weight ?? 0.5);
    // Confidence follows the weight down; leaving it high would keep the
    // downgraded edge winning any confidence-ordered comparison.
    const currentConfidence = Number.isFinite(Number(edge.confidence)) ? Number(edge.confidence) : edge.weight;
    edge.confidence = clamp01(Math.min(currentConfidence, edge.weight), edge.weight);
  }
  if (Number.isFinite(spec.confidence)) {
    edge.confidence = clamp01(spec.confidence, edge.confidence ?? edge.weight ?? 0.5);
  }
  if (spec.marker) edge.celiski = spec.marker;
  edge.updated_at = nowIso();
}

/**
 * Lower a contradicted edge's trust through the canonical record rather than a
 * clone, keeping the in-memory edge, the indexes and the durable row in step.
 *
 * Deliberately does not reclassify the edge onto a different target/relation.
 * The negation that triggers a downgrade is itself learned as its own edge by
 * the caller immediately afterwards; rewriting this edge's identity to that
 * same triple would collide with it and leave the reported weight disagreeing
 * with the stored one. Downgrading in place keeps both facts — the weakened
 * original assertion and the new negation — and keeps the conflict text true.
 *
 * @returns {{previous: object, edge: object}|null} null when no such edge
 *   exists in the workspace.
 */
function downgradeEdge(graph, spec = {}) {
  const workspaceId = normalizeWorkspaceId(spec.workspaceId);
  const live = findLiveEdge(graph, spec.fromId, spec.toId, spec.relation, workspaceId);
  if (!live) return null;

  const previous = {
    to: live.to,
    relation: live.relation,
    weight: live.weight,
    confidence: live.confidence,
  };

  applyDowngradeFields(live, spec);
  persistEdgeUpdate(graph, live, workspaceId);
  return { previous, edge: cloneEdgeRecord(live) };
}

module.exports = {
  applyTemporalEdgeMetadata,
  beginEdgeTouchScope,
  downgradeEdge,
  edgeTouchKey,
};
