'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

function getCandidateClaims(candidates, filters = {}) {
  const normalizedFilters = { ...filters };
  if (Object.prototype.hasOwnProperty.call(filters, 'workspaceId')) {
    if (filters.workspaceId === undefined || filters.workspaceId === null) {
      normalizedFilters.workspaceId = undefined;
    } else if (typeof filters.workspaceId === 'string' && !filters.workspaceId.trim()) {
      normalizedFilters.workspaceId = null;
    } else {
      normalizedFilters.workspaceId = normalizeWorkspaceId(filters.workspaceId);
    }
  } else {
    normalizedFilters.workspaceId = undefined;
  }
  return candidates.filter((candidate) => {
    if (normalizedFilters.workspaceId === null) return false;
    if (normalizedFilters.workspaceId !== undefined && normalizeWorkspaceId(candidate.workspaceId) !== normalizeWorkspaceId(normalizedFilters.workspaceId)) return false;
    if (normalizedFilters.status && candidate.status !== normalizedFilters.status) return false;
    if (normalizedFilters.recommendation && candidate.recommendation !== normalizedFilters.recommendation) return false;
    if (normalizedFilters.candidateId && candidate.candidateId !== normalizedFilters.candidateId) return false;
    if (normalizedFilters.reviewedBy && candidate.reviewedBy !== normalizedFilters.reviewedBy) return false;
    if (normalizedFilters.provenanceId && candidate.provenance?.provenanceId !== normalizedFilters.provenanceId) return false;
    if (normalizedFilters.sourceRef && candidate.provenance?.sourceRef !== normalizedFilters.sourceRef) return false;
    return true;
  });
}

module.exports = { getCandidateClaims };
