'use strict';

// The bounded audit-trail page (#729) and the candidate-claims query for the
// provenance query surface. Split out of lib/provenance-query.js (#2162):
// both moved here byte-identical.

const { clampAuditLimit, encodeAuditCursor } = require('./audit-query');
const { candidateTargetIds } = require('./canonical-target-match');
const {
  coerceString,
  getGraph,
  publicAuditEvent,
  publicCandidateClaim,
} = require('./provenance-query-shapes');
const { matchesWorkspace, recordSort } = require('./provenance-query-query-helpers');
const { normalizeWorkspaceId } = require('./workspace-id');

/**
 * One bounded page of the audit trail (#729).
 *
 * The previous shape of this function asked the graph for every matching event
 * and returned all of them. On SQLite that meant reading, JSON-parsing,
 * cloning and sorting the complete audit history for even a highly selective
 * query, and handing the caller an unbounded response — so an authenticated
 * client could make repeated cheap requests cost O(total audit history) each.
 *
 * Filters and ordering are now pushed into SQL and the page is capped, with a
 * keyset cursor for continuation. Ordering is (timestamp, targetId, auditId),
 * which matches recordSort()'s tie-break and adds auditId so equal pairs still
 * have one defined order — a requirement for the cursor to be stable.
 *
 * @returns {{items: Array, hasMore: boolean, nextCursor: string|null, limit: number}}
 */
function queryAuditTrailPage(target, filters = {}) {
  const graph = getGraph(target);
  const empty = { items: [], hasMore: false, nextCursor: null, limit: clampAuditLimit(filters.limit) };
  if (!graph || typeof graph.getAuditEvents !== 'function') return empty;

  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const crossWorkspace = filters.crossWorkspace === true;
  const order = filters.order === 'desc' ? 'desc' : 'asc';
  const baseFilters = {
    workspaceId: crossWorkspace ? undefined : workspaceId,
    eventType: filters.eventType,
    targetId: filters.targetId,
    provenanceId: filters.provenanceId,
    sourceRef: filters.sourceRef,
    actor: filters.actor,
  };

  // A graph without the bounded primitive still has to answer; it just pays
  // the old cost, and the page is trimmed here so the response stays bounded.
  if (typeof graph.queryAuditEvents !== 'function') {
    const limit = clampAuditLimit(filters.limit);
    const all = graph.getAuditEvents(baseFilters)
      .map(publicAuditEvent)
      .filter(Boolean)
      .filter((event) => matchesWorkspace(event.workspaceId, workspaceId, crossWorkspace))
      .sort((a, b) => recordSort(a, b, order));
    const hasMore = all.length > limit;
    const items = hasMore ? all.slice(0, limit) : all;
    return { items, hasMore, nextCursor: hasMore ? encodeAuditCursor(items[items.length - 1]) : null, limit };
  }

  const page = graph.queryAuditEvents({
    filters: baseFilters,
    limit: filters.limit,
    cursor: filters.cursor,
    order,
  });

  // The workspace predicate is already in SQL; this only re-asserts it so a
  // future change to the pushdown cannot silently widen the result.
  const items = page.items
    .map(publicAuditEvent)
    .filter(Boolean)
    .filter((event) => matchesWorkspace(event.workspaceId, workspaceId, crossWorkspace));

  return { items, hasMore: page.hasMore, nextCursor: page.nextCursor, limit: page.limit };
}

function queryCandidateClaims(target, filters = {}) {
  const graph = getGraph(target);
  if (!graph || typeof graph.getCandidateClaims !== 'function') return [];
  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const crossWorkspace = filters.crossWorkspace === true;
  const order = filters.order === 'desc' ? 'desc' : 'asc';
  const source = crossWorkspace
    ? graph.getCandidateClaims()
    : graph.getCandidateClaims({ workspaceId });
  const items = source
    .map(publicCandidateClaim)
    .filter(Boolean)
    .filter((candidate) => matchesWorkspace(candidate.workspaceId, workspaceId, crossWorkspace))
    .filter((candidate) => {
      const targetMatch = !filters.targetId
        || candidateTargetIds(candidate).has(filters.targetId);
      if (!targetMatch) return false;
      if (filters.candidateId && candidate.candidateId !== filters.candidateId) return false;
      if (filters.status && candidate.status !== filters.status) return false;
      if (filters.recommendation && candidate.recommendation !== filters.recommendation) return false;
      if (filters.sourceRef && candidate.provenance?.sourceRef !== filters.sourceRef) return false;
      if (filters.provenanceId && candidate.provenance?.provenanceId !== filters.provenanceId) return false;
      return true;
    });
  items.sort((a, b) => recordSort(a, b, order));
  return items;
}

module.exports = {
  queryAuditTrailPage,
  queryCandidateClaims,
};
