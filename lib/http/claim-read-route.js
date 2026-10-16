'use strict';

// #2788 Phase 2: GET /api/claim-read exposes lib/claim-read.js's readClaim()
// over HTTP, mirroring lib/http/trust-query-routes.js's mount shape (factory
// takes its collaborators, returns one handler the composition root calls in
// order). Kept as its own mount rather than folded into trust-query-routes.js
// because that route answers "what is the receipt for this target", while
// this one answers "what can I safely act on right now" -- a different
// question with a different response shape (a discriminated union, not a
// receipt), per the design on #2788 (issuecomment-5784967135,
// issuecomment-5784993182).

const { readClaim } = require('../claim-read');
const { readClaimReadIntent } = require('../http-trust-query');

function createClaimReadRoute({
  graph,
  writeJson,
  writeApiError,
  denyIfUnauthorized,
  readExactWorkspace,
  writeStructuredLog,
}) {
  function handleClaimReadRoute(req, res, reqUrl, correlation) {
    if (reqUrl.pathname !== '/api/claim-read') return false;

    if (req.method !== 'GET') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    if (!denyIfUnauthorized(req, res)) return true;

    const workspace = readExactWorkspace(reqUrl.searchParams);
    if (!workspace.ok) {
      writeApiError(req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
      return true;
    }

    const targetId = (reqUrl.searchParams.get('targetId') || '').trim();
    if (!targetId) {
      writeApiError(req, res, 400, 'INVALID_QUERY', 'targetId is required.');
      return true;
    }

    try {
      const intent = readClaimReadIntent(reqUrl);
      const result = readClaim({ graph }, {
        workspaceId: workspace.workspaceId,
        targetId,
        intent: Object.keys(intent).length ? intent : undefined,
      });
      writeJson(req, res, 200, { ok: true, data: result }, { 'Cache-Control': 'no-cache' });
    } catch (err) {
      writeStructuredLog(console, 'error', 'http.claim_read_error', correlation, { route: '/api/claim-read', method: req.method, errorCode: err?.code || 'CLAIM_READ_FAILED' });
      writeApiError(req, res, 500, 'CLAIM_READ_FAILED', 'claim read failed');
    }
    return true;
  }

  return { handleClaimReadRoute };
}

module.exports = { createClaimReadRoute };
