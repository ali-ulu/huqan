'use strict';

const { normalizeCandidateClaim } = require('./conflict-detector');
const { normalizeWorkspaceId } = require('./graph-record-utils');

/**
 * Owns candidate-claim normalization and write orchestration. The Graph store
 * API retains collection mutation, SQLite statement access, and read-back.
 */
function addCandidateClaim(storeApi, candidate, opts = {}) {
  const normalized = normalizeCandidateClaim({
    ...candidate,
    workspaceId: opts.workspaceId
      || candidate?.workspaceId
      || candidate?.provenance?.workspaceId
      || candidate?.proposedEdge?.workspaceId,
  });
  const workspaceId = normalizeWorkspaceId(normalized.workspaceId);
  const index = storeApi.findIndex(normalized.candidateId, workspaceId);

  if (index >= 0) {
    storeApi.replace(index, {
      ...storeApi.get(index),
      ...normalized,
      workspaceId,
      candidateId: normalized.candidateId,
    });
  } else {
    storeApi.append({
      ...normalized,
      workspaceId,
      candidateId: normalized.candidateId,
    });
  }

  storeApi.persist(normalized, workspaceId);

  return storeApi.read({ workspaceId }).find(item => item.candidateId === normalized.candidateId) || normalized;
}

module.exports = { addCandidateClaim };
