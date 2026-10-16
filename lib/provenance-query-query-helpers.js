'use strict';

// Query-scope and filter/sort helpers for the provenance query surface.
// Split out of lib/provenance-query.js (#2162): workspace matching, filter
// matching, and the shared record sort moved here byte-identical.

const { normalizeWorkspaceId } = require('./workspace-id');

function matchesProvenanceFilters(provenance, filters = {}) {
  if (!provenance) return false;
  if (filters.provenanceId && provenance.provenanceId !== filters.provenanceId) return false;
  if (filters.sourceRef && provenance.sourceRef !== filters.sourceRef) return false;
  if (filters.sourceType && provenance.sourceType !== filters.sourceType) return false;
  if (filters.actor && provenance.actor !== filters.actor) return false;
  if (filters.sourceSubType && provenance.sourceSubType !== filters.sourceSubType) return false;
  return true;
}

function matchesWorkspace(itemWorkspaceId, filtersWorkspaceId, crossWorkspace = false) {
  if (crossWorkspace) return true;
  return normalizeWorkspaceId(itemWorkspaceId) === normalizeWorkspaceId(filtersWorkspaceId);
}

function recordSort(a, b, order = 'asc') {
  const timestampDiff = String(a.timestamp || a.createdAt || a.created_at || '').localeCompare(String(b.timestamp || b.createdAt || b.created_at || ''));
  if (timestampDiff !== 0) return order === 'desc' ? -timestampDiff : timestampDiff;
  const idA = String(a.targetId || a.candidateId || a.auditId || a.provenance?.provenanceId || '');
  const idB = String(b.targetId || b.candidateId || b.auditId || b.provenance?.provenanceId || '');
  const diff = idA.localeCompare(idB);
  return order === 'desc' ? -diff : diff;
}

module.exports = {
  matchesProvenanceFilters,
  matchesWorkspace,
  recordSort,
};
