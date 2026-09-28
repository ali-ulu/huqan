'use strict';

// Detection side of lib/conflict-detector.js (#2120): evidence summaries,
// graph accessors, the conflict-result builder and detectClaimConflict.
// Moved verbatim; claim shapes come from lib/conflict-claim.js and routing
// stays in the entry.
const { normalizeWorkspaceId } = require('./workspace-id');
const { isPlainObject } = require('./is-plain-object');
const {
  CONFLICT_TYPES,
  CONFLICT_RECOMMENDATIONS,
  CAUSAL_RELATIONS,
  coerceString,
  relationConflicts,
  normalizeCandidateClaim,
  edgeRef,
} = require('./conflict-claim');

function summarizeExistingEvidence(edges = []) {
  return edges.map(edgeRef);
}

function summarizeProposedEvidence(candidate) {
  if (!candidate || !candidate.proposedEdge) return [];
  return [edgeRef(candidate.proposedEdge)];
}

function getGraph(kernelOrGraph) {
  return kernelOrGraph && kernelOrGraph.graph ? kernelOrGraph.graph : kernelOrGraph;
}

// #217: journal only when both a Kernel-shaped journal owner and an injected admission evaluator are available.
function getJournalingKernel(kernelOrGraph, evaluateLearnAdmission) {
  if (typeof evaluateLearnAdmission !== 'function') return null;
  for (const candidate of [kernelOrGraph, kernelOrGraph && kernelOrGraph.kernel]) {
    if (candidate?.graph && typeof candidate.graph.runMutationOnce === 'function') return candidate;
  }
  return null;
}

function appendAudit(kernelOrGraph, event, provenance, workspaceId) {
  const graph = getGraph(kernelOrGraph);
  if (!graph || typeof graph.appendAuditEvent !== 'function') return null;
  const payload = { ...event, workspaceId };
  const write = () => graph.appendAuditEvent(payload, provenance ? { provenance, workspaceId } : { workspaceId });
  if (!kernelOrGraph || kernelOrGraph.graph !== graph) return write();
  try { return write(); } catch (error) {
    console.error('[Kernel] Audit log error:', error.message);
    return null;
  }
}

function buildConflictResult({
  conflict = false,
  type = null,
  recommendation = CONFLICT_RECOMMENDATIONS.ACCEPT,
  reason = 'No conflicting graph-backed claim found.',
  confidenceDelta = 0,
  existingEvidence = [],
  proposedEvidence = [],
  workspaceId = 'default',
  provenanceId = '',
  sourceRef = '',
} = {}) {
  return {
    conflict,
    type,
    recommendation,
    reason,
    confidenceDelta,
    existingEvidence,
    proposedEvidence,
    workspaceId,
    provenanceId,
    sourceRef,
  };
}

function detectClaimConflict(kernelOrGraph, claim, opts = {}) {
  const graph = getGraph(kernelOrGraph);
  const workspaceId = normalizeWorkspaceId(claim?.workspaceId || opts.workspaceId);
  const normalizedProposed = normalizeCandidateClaim({ proposedEdge: claim?.proposedEdge || claim?.edge || claim }).proposedEdge;
  const proposedEdge = normalizedProposed && coerceString(normalizedProposed.from) && coerceString(normalizedProposed.to) && coerceString(normalizedProposed.relation)
    ? normalizedProposed
    : (isPlainObject(claim) && claim.subject && claim.relation && claim.object
      ? {
          from: claim.subject,
          relation: claim.relation,
          to: claim.object,
          confidence: claim.confidence ?? 0.5,
          provenanceId: claim.provenance?.provenanceId || claim.provenanceId || '',
          sourceRef: claim.provenance?.sourceRef || claim.sourceRef || '',
          workspaceId,
        }
      : null);
  const provenance = isPlainObject(claim?.provenance) ? claim.provenance : null;
  const provenanceId = coerceString(provenance?.provenanceId || claim?.provenanceId, '');
  const sourceRef = coerceString(provenance?.sourceRef || claim?.sourceRef, '');

  if (opts.strictProvenance && !provenance) {
    return buildConflictResult({
      conflict: true,
      type: CONFLICT_TYPES.PROVENANCE_MISMATCH,
      recommendation: CONFLICT_RECOMMENDATIONS.REJECT,
      reason: 'Strict provenance requires provenance metadata.',
      workspaceId,
      provenanceId,
      sourceRef,
    });
  }

  if (provenance && normalizeWorkspaceId(provenance.workspaceId || workspaceId) !== workspaceId) {
    return buildConflictResult({
      conflict: true,
      type: CONFLICT_TYPES.WORKSPACE_SCOPE_MISMATCH,
      recommendation: CONFLICT_RECOMMENDATIONS.REJECT,
      reason: 'Claim workspace does not match provenance workspace.',
      workspaceId,
      provenanceId,
      sourceRef,
    });
  }

  if (!graph || !proposedEdge || !coerceString(proposedEdge.from) || !coerceString(proposedEdge.to) || !coerceString(proposedEdge.relation)) {
    return buildConflictResult({ workspaceId, provenanceId, sourceRef });
  }

  const from = coerceString(proposedEdge.from);
  const to = coerceString(proposedEdge.to);
  const relation = coerceString(proposedEdge.relation);
  const candidateConfidence = typeof proposedEdge.confidence === 'number'
    ? proposedEdge.confidence
    : typeof proposedEdge.weight === 'number'
      ? proposedEdge.weight
      : 0.5;
  const samePairEdges = typeof graph.getEdgesBetween === 'function'
    ? graph.getEdgesBetween(from, to, workspaceId)
    : (typeof graph.getEdges === 'function' ? graph.getEdges(from, workspaceId).filter(edge => edge.to === to) : []);
  const conflictingEdges = samePairEdges.filter((edge) => relationConflicts(relation, edge.relation) || relationConflicts(edge.relation, relation));
  const exactEdge = typeof graph.getEdge === 'function'
    ? graph.getEdge(from, to, relation, workspaceId)
    : null;

  if (exactEdge && !conflictingEdges.length) {
    return buildConflictResult({ workspaceId, provenanceId, sourceRef });
  }

  if (conflictingEdges.length > 0) {
    const existing = conflictingEdges[0];
    // Use the canonical edge reader rather than re-deriving the id here.
    const existingProvenanceId = edgeRef(existing).provenanceId;
    const conflictType = CAUSAL_RELATIONS.has(relation) || CAUSAL_RELATIONS.has(existing.relation)
      ? CONFLICT_TYPES.AGENT_VS_CAUSAL
      : (existingProvenanceId && provenanceId && existingProvenanceId !== provenanceId)
        ? CONFLICT_TYPES.AGENT_VS_AGENT
        : CONFLICT_TYPES.AGENT_VS_GRAPH;
    const recommendation = CONFLICT_RECOMMENDATIONS.FLAG;
    const delta = Math.abs((existing.confidence ?? existing.weight ?? 0.5) - candidateConfidence);
    return buildConflictResult({
      conflict: true,
      type: conflictType,
      recommendation,
      reason: 'Claim contradicts an existing graph-backed edge.',
      confidenceDelta: Number(delta.toFixed(2)),
      existingEvidence: summarizeExistingEvidence(conflictingEdges),
      proposedEvidence: summarizeProposedEvidence({ proposedEdge }),
      workspaceId,
      provenanceId,
      sourceRef,
    });
  }

  return buildConflictResult({
    workspaceId,
    provenanceId,
    sourceRef,
  });
}

module.exports = {
  summarizeExistingEvidence,
  summarizeProposedEvidence,
  getGraph,
  getJournalingKernel,
  appendAudit,
  buildConflictResult,
  detectClaimConflict,
};
