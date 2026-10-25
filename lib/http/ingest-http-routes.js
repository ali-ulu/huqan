const { publicIngestApproval } = require('../server-response-helpers');
const { writeStructuredLog } = require('./structured-log');
const {
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_MAX_JSON_BODY,
  sanitizeInput,
} = require('../../requestGuards');
const path = require('path');
const os = require('os');
const { createDurableCapabilityNonceStore } = require('../mcp-capability-nonce-store');
const { operatorCapabilityBinding } = require('../mcp/operator-authorization');
const { verifyMcpOperatorCapability } = require('../mcp-operator-capability');

const OPERATOR_CAPABILITY_HEADER = 'x-huqan-operator-capability';

function ingestApprovalNonceDirectory(kernel) {
  const memoryPath = typeof kernel?.graph?.memoryPath === 'string' ? kernel.graph.memoryPath.trim() : '';
  const base = memoryPath
    ? path.dirname(path.resolve(memoryPath))
    : path.join(os.homedir(), '.local', 'state', 'huqan');
  return path.join(base, '.huqan-capability-nonces');
}

function requestWorkspaceId(reqUrl) {
  return sanitizeInput(reqUrl.searchParams.get('workspaceId') || 'default', 128) || 'default';
}

function createIngestHttpRoutes({
  kernel,
  approvalRuntime,
  ensureCompanyRuntime,
  parseJsonRequest,
  denyIfUnauthorized,
  writeJson,
  writeApiError,
  operatorToken = '',
  capabilityNonces: injectedNonces,
}) {
  // #4227 (CWE-863): with an operator token configured, listing and deciding
  // ingest approvals takes a capability bound to the exact request.
  const capabilityNonces = operatorToken
    ? injectedNonces || createDurableCapabilityNonceStore({ directory: ingestApprovalNonceDirectory(kernel) })
    : null;

  function operatorRefused(req, res, name, args) {
    if (!capabilityNonces) return false;
    const presented = req.headers[OPERATOR_CAPABILITY_HEADER];
    const verdict = verifyMcpOperatorCapability({
      secret: operatorToken,
      capability: typeof presented === 'string' ? presented : '',
      expected: operatorCapabilityBinding(name, args),
      nonceStore: capabilityNonces,
    });
    if (verdict.ok === true) return false;
    writeApiError(req, res, 403, 'OPERATOR_AUTH_REQUIRED',
      `A scoped operator capability is required. Present it in ${OPERATOR_CAPABILITY_HEADER}.`);
    return true;
  }

  return async function handleIngestHttpRoutes(req, res, reqUrl, correlation) {
    if (reqUrl.pathname === '/api/ingest/status') {
      if (req.method !== 'GET') {
        writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      try {
        ensureCompanyRuntime();
        const status = await kernel.runCapability('ingestStatus', {});
        writeJson(req, res, 200, status, { 'Cache-Control': 'no-cache' });
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.ingest_status_error', correlation, {
          route: '/api/ingest/status',
          method: req.method,
          errorCode: err?.code || 'INGEST_STATUS_FAILED',
        });
        writeApiError(req, res, 500, 'INGEST_STATUS_FAILED', 'Ingest status failed.');
      }
      return true;
    }

    if (reqUrl.pathname === '/api/ingest/approvals') {
      if (req.method !== 'GET') {
        writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      const limit = Math.min(100, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 50));
      const workspaceId = requestWorkspaceId(reqUrl);
      if (operatorRefused(req, res, 'huqan.approvals', { limit, workspaceId })) return true;
      try {
        approvalRuntime.recover();
        const approvals = approvalRuntime.getStore()
          .listUnresolvedToolApprovals(limit, workspaceId)
          .filter(item => item.tool === 'http.ingest')
          .map(publicIngestApproval);
        writeJson(req, res, 200, { ok: true, approvals }, { 'Cache-Control': 'no-cache' });
      } catch (_) {
        writeApiError(
          req,
          res,
          503,
          'APPROVAL_STORE_UNAVAILABLE',
          'Persistent ingest approval store is unavailable.',
        );
      }
      return true;
    }

    const approvalMatch = reqUrl.pathname.match(/^\/api\/ingest\/approvals\/([^/]+)$/);
    if (approvalMatch) {
      if (req.method !== 'POST') {
        writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      const body = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_JSON_BODY });
      if (!body) return true;
      const approvalId = sanitizeInput(decodeURIComponent(approvalMatch[1]), 256);
      const decision = String(body.decision || '').trim().toLowerCase();
      if (!approvalId || !['approved', 'rejected'].includes(decision)) {
        writeApiError(
          req,
          res,
          400,
          'INVALID_APPROVAL_DECISION',
          'approval id and decision approved|rejected are required.',
        );
        return true;
      }
      const decisionArgs = { approvalId, workspaceId: requestWorkspaceId(reqUrl), decision, reason: String(body.reason || '') };
      if (operatorRefused(req, res, 'huqan.approve', decisionArgs)) return true;
      try {
        const store = approvalRuntime.getStore();
        approvalRuntime.recover(store);
        const outcome = await approvalRuntime.decide(decisionArgs);
        if (outcome.error) {
          writeApiError(
            req,
            res,
            outcome.status,
            outcome.error.code,
            outcome.error.message,
            outcome.error.details,
          );
          return true;
        }
        writeJson(req, res, outcome.status, outcome.json, { 'Cache-Control': 'no-cache' });
      } catch (error) {
        writeStructuredLog(console, 'error', 'http.ingest_approval_error', correlation, {
          route: '/api/ingest/approval',
          method: req.method,
          errorCode: error?.code || 'INGEST_APPROVAL_FAILED',
        });
        writeApiError(
          req,
          res,
          500,
          'INGEST_APPROVAL_FAILED',
          'Ingest approval failed; inspect unresolved approvals.',
        );
      }
      return true;
    }

    if (reqUrl.pathname === '/api/ingest') {
      if (req.method !== 'POST') {
        writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_UPLOAD_BODY });
      if (!data) return true;
      const outcome = await approvalRuntime.submit(data);
      if (outcome.error) {
        writeApiError(req, res, outcome.status, outcome.error.code, outcome.error.message);
      } else {
        writeJson(req, res, outcome.status, outcome.json, { 'Cache-Control': 'no-cache' });
      }
      return true;
    }

    return false;
  };
}

module.exports = { createIngestHttpRoutes };
