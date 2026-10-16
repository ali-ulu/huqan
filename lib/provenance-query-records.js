'use strict';

// Node/edge/candidate-claim record collection and the canonical-record
// lookup for the provenance query surface. Split out of
// lib/provenance-query.js (#2162): queryProvenance() and
// findCanonicalRecord() moved here byte-identical.

const { candidateTargetIds } = require('./canonical-target-match');
const {
  coerceString,
  getGraph,
  normalizeEntityResolution,
  provenanceShape,
  publicCandidateClaim,
  safeJsonClone,
} = require('./provenance-query-shapes');
const { matchesProvenanceFilters, matchesWorkspace, recordSort } = require('./provenance-query-query-helpers');
const { normalizeWorkspaceId } = require('./workspace-id');

function queryProvenance(target, filters = {}) {
  const graph = getGraph(target);
  if (!graph) return [];
  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const crossWorkspace = filters.crossWorkspace === true;
  const targetId = coerceString(filters.targetId, '');
  const records = [];
  const nodes = Object.values(graph._nodes || {});
  const edges = Array.isArray(graph._edges) ? graph._edges : [];
  const candidates = typeof graph.getCandidateClaims === 'function'
    ? (crossWorkspace ? graph.getCandidateClaims() : graph.getCandidateClaims({ workspaceId }))
    : [];

  for (const node of nodes) {
    if (!matchesWorkspace(node.workspaceId, workspaceId, crossWorkspace)) continue;
    if (!node.provenance) continue;
    if (!matchesProvenanceFilters(node.provenance, filters)) continue;
    if (targetId && node.id !== targetId) continue;
    records.push({
      kind: 'node',
      targetType: 'node',
      targetId: node.id,
      claim: node.label || node.id,
      status: 'canonical',
      canonical: true,
      workspaceId: normalizeWorkspaceId(node.workspaceId),
      confidence: typeof node.provenance.confidence === 'number' ? node.provenance.confidence : node.weight ?? 0.5,
      provenance: provenanceShape(node.provenance, node.workspaceId),
      trustPolicyVersion: coerceString(node.provenance?.trustPolicyVersion, ''),
      createdAt: node.created_at || node.last_seen || '',
    });
  }

  for (const edge of edges) {
    if (!matchesWorkspace(edge.workspaceId, workspaceId, crossWorkspace)) continue;
    if (!edge.provenance) continue;
    if (!matchesProvenanceFilters(edge.provenance, filters)) continue;
    const compositeId = `${edge.from}|${edge.relation}|${edge.to}`;
    if (targetId && targetId !== compositeId && targetId !== edge.from && targetId !== edge.to) continue;
    const entityResolution = normalizeEntityResolution(edge.meta?.entityResolution);
    records.push({
      kind: 'edge',
      targetType: 'edge',
      targetId: compositeId,
      claim: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
      status: 'canonical',
      canonical: true,
      workspaceId: normalizeWorkspaceId(edge.workspaceId),
      confidence: typeof edge.provenance.confidence === 'number' ? edge.provenance.confidence : edge.confidence ?? edge.weight ?? 0.5,
      provenance: provenanceShape(edge.provenance, edge.workspaceId),
      trustPolicyVersion: coerceString(edge.provenance?.trustPolicyVersion, ''),
      createdAt: edge.created_at || edge.updated_at || '',
      ...(entityResolution ? { entityResolution } : {}),
    });
  }

  for (const candidate of candidates) {
    const normalized = publicCandidateClaim(candidate);
    if (!normalized || !normalized.provenance) continue;
    if (!matchesWorkspace(normalized.workspaceId, workspaceId, crossWorkspace)) continue;
    if (!matchesProvenanceFilters(normalized.provenance, filters)) continue;
    const targets = candidateTargetIds(normalized);
    if (targetId && !targets.has(targetId)) continue;
    records.push({
      kind: 'candidate_claim',
      targetType: 'candidate_claim',
      targetId: normalized.candidateId,
      claim: normalized.claim,
      status: normalized.status,
      canonical: normalized.status === 'accepted',
      workspaceId: normalized.workspaceId,
      confidence: typeof normalized.provenance.confidence === 'number' ? normalized.provenance.confidence : normalized.proposedEdge?.confidence ?? 0.5,
      provenance: normalized.provenance,
      trustPolicyVersion: normalized.provenance?.trustPolicyVersion || '',
      createdAt: normalized.createdAt,
      recommendation: normalized.recommendation,
      conflict: safeJsonClone(normalized.conflict, null),
      candidateClaim: normalized,
    });
  }

  records.sort((a, b) => recordSort(a, b, filters.order || 'asc'));
  return records;
}

function findCanonicalRecord(target, filters, provenanceRecords, candidateClaims) {
  const graph = getGraph(target);
  if (!graph) return null;
  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const targetId = coerceString(filters.targetId, '');

  if (targetId) {
    if (typeof graph.getNode === 'function') {
      const node = graph.getNode(targetId, workspaceId);
      if (node) {
        return {
          kind: 'node',
          targetType: 'node',
          targetId: node.id,
          claim: node.label || node.id,
          status: 'canonical',
          canonical: true,
          workspaceId: normalizeWorkspaceId(node.workspaceId),
          confidence: typeof node.provenance?.confidence === 'number' ? node.provenance.confidence : node.weight ?? 0.5,
          provenance: provenanceShape(node.provenance, node.workspaceId),
          trustPolicyVersion: coerceString(node.provenance?.trustPolicyVersion, ''),
          createdAt: node.created_at || node.last_seen || '',
        };
      }
    }
    if (Array.isArray(graph._edges)) {
      const edge = graph._edges.find((item) => {
        const compositeId = `${item.from}|${item.relation}|${item.to}`;
        return normalizeWorkspaceId(item.workspaceId) === workspaceId && (
          item.from === targetId ||
          item.to === targetId ||
          compositeId === targetId
        );
      });
      if (edge) {
        return {
          kind: 'edge',
          targetType: 'edge',
          targetId: `${edge.from}|${edge.relation}|${edge.to}`,
          claim: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
          status: 'canonical',
          canonical: true,
          workspaceId: normalizeWorkspaceId(edge.workspaceId),
          confidence: typeof edge.provenance?.confidence === 'number' ? edge.provenance.confidence : edge.confidence ?? edge.weight ?? 0.5,
          provenance: provenanceShape(edge.provenance, edge.workspaceId),
          trustPolicyVersion: coerceString(edge.provenance?.trustPolicyVersion, ''),
          createdAt: edge.created_at || edge.updated_at || '',
        };
      }
    }
  }

  if (provenanceRecords.length > 0) {
    const first = provenanceRecords[0];
    return {
      ...first,
      canonical: first.status === 'canonical',
    };
  }

  return null;
}

module.exports = {
  findCanonicalRecord,
  queryProvenance,
};
