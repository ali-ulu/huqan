'use strict';

// Mounted from server.js by #2128 slice 2. The four trust query routes
// (/api/provenance, /api/audit, /api/candidate-claims, /api/trust-receipt)
// moved here verbatim; the composition root keeps one mount line. The graph
// and the route collaborators arrive through the factory; the provenance
// queries are required here because their only server.js uses moved with
// the block — nothing is constructed here.

const {
  buildTrustReceipt,
  queryAuditTrailPage,
  queryCandidateClaims,
  queryProvenance,
} = require('../provenance-query');
// #2788 Phase 2: required here, not by server.js directly, so the new
// /api/claim-read mount does not add to server.js's own fan-out -- this
// module already owns the trust-query require and has the headroom.
const { createClaimReadRoute } = require('./claim-read-route');

function createTrustQueryRoutes({
  graph,
  writeJson,
  writeApiError,
  denyIfUnauthorized,
  readExactWorkspace,
  readTrustFilters,
  hasTrustQuery,
  writeStructuredLog,
}) {
  const { handleClaimReadRoute } = createClaimReadRoute({
    graph, writeJson, writeApiError, denyIfUnauthorized, readExactWorkspace, writeStructuredLog,
  });

  function handleTrustQueryRoutes(req, res, reqUrl, correlation) {
    if (handleClaimReadRoute(req, res, reqUrl, correlation)) return true;
    if (reqUrl.pathname === '/api/provenance' || reqUrl.pathname === '/api/audit' || reqUrl.pathname === '/api/candidate-claims' || reqUrl.pathname === '/api/trust-receipt') {
      if (req.method !== 'GET') {
        writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      const exactWorkspaceRequired = reqUrl.pathname === '/api/audit'
        || reqUrl.pathname === '/api/trust-receipt';
      const workspace = exactWorkspaceRequired ? readExactWorkspace(reqUrl.searchParams) : null;
      if (workspace && !workspace.ok) {
        writeApiError(req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
        return true;
      }
      const filters = readTrustFilters(reqUrl);
      const workspaceId = workspace ? workspace.workspaceId : (filters.workspaceId || 'default');
      try {
        if (reqUrl.pathname === '/api/provenance') {
          if (!hasTrustQuery(filters, ['targetId', 'provenanceId', 'sourceRef', 'sourceType', 'actor'])) {
            writeApiError(req, res, 400, 'INVALID_QUERY', 'targetId, provenanceId, sourceRef, sourceType, or actor is required.');
        return true;
          }
          const items = queryProvenance(graph, { ...filters, workspaceId });
          writeJson(req, res, 200, {
            ok: true,
            data: {
              items,
              total: items.length,
              workspaceId,
            },
          }, { 'Cache-Control': 'no-cache' });
        return true;
        }

        if (reqUrl.pathname === '/api/audit') {
          if (!hasTrustQuery(filters, ['targetId', 'provenanceId', 'sourceRef', 'eventType', 'actor'])) {
            writeApiError(req, res, 400, 'INVALID_QUERY', 'targetId, provenanceId, sourceRef, eventType, or actor is required.');
        return true;
          }
          // Bounded page, not the whole trail (#729). `total` is this page's
          // item count; hasMore/nextCursor carry continuation.
          const page = queryAuditTrailPage(graph, { ...filters, workspaceId });
          const { items, limit, hasMore, nextCursor } = page;
          writeJson(req, res, 200, {
            ok: true,
            data: { items, total: items.length, limit, hasMore, nextCursor, workspaceId },
          }, { 'Cache-Control': 'no-cache' });
        return true;
        }

        if (reqUrl.pathname === '/api/candidate-claims') {
          if (!hasTrustQuery(filters, ['candidateId', 'status', 'recommendation', 'sourceRef', 'targetId'])) {
            writeApiError(req, res, 400, 'INVALID_QUERY', 'candidateId, status, recommendation, sourceRef, or targetId is required.');
        return true;
          }
          const items = queryCandidateClaims(graph, { ...filters, workspaceId });
          writeJson(req, res, 200, {
            ok: true,
            data: {
              items,
              total: items.length,
              workspaceId,
            },
          }, { 'Cache-Control': 'no-cache' });
        return true;
        }

        if (!hasTrustQuery(filters, ['targetId', 'provenanceId', 'sourceRef', 'candidateId', 'eventType'])) {
          writeApiError(req, res, 400, 'INVALID_QUERY', 'targetId, provenanceId, sourceRef, candidateId, or eventType is required.');
        return true;
        }
        const receipt = buildTrustReceipt({ ...filters, workspaceId }, { target: graph });
        writeJson(req, res, 200, {
          ok: true,
          data: receipt,
        }, { 'Cache-Control': 'no-cache' });
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.trust_query_error', correlation, { route: '/api/trust', method: req.method, errorCode: err?.code || 'TRUST_QUERY_FAILED' });
        writeApiError(req, res, 500, 'TRUST_QUERY_FAILED', 'trust query failed');
      }
        return true;
    }
    return false;
  }

  return { handleTrustQueryRoutes };
}

module.exports = { createTrustQueryRoutes };
