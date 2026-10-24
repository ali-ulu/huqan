const { publicIngestApproval } = require('../server-response-helpers');
const { writeStructuredLog } = require('./structured-log');
const {
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_MAX_JSON_BODY,
  sanitizeInput,
} = require('../../requestGuards');
const path = require('path');
const os = require('os');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { createDurableCapabilityNonceStore } = require('../mcp-capability-nonce-store');
const {
  operatorCapabilityBinding,
  verifyMcpOperatorCapability,
} = require('../../mcpServer');

const OPERATOR_CAPABILITY_HEADER = 'x-huqan-operator-capability';

function operatorAuthorized(configuredSecret, presentedCapability, name, args, nonceStore) {
  if (typeof configuredSecret !== 'string' || !configuredSecret || typeof presentedCapability !== 'string') return false;
  const result = verifyMcpOperatorCapability({
    secret: configuredSecret,
    capability: presentedCapability,
    expected: operatorCapabilityBinding(name, args),
    nonceStore,
  });
  return result.ok === true;
}

function readOperatorCapability(req) {
  const raw = req && req.headers ? req.headers[OPERATOR_CAPABILITY_HEADER] : '';
  return typeof raw === 'string' ? raw : '';
}

function ingestApprovalNonceDirectory(kernel) {
  const memoryPath = kernel && kernel.graph && typeof kernel.graph.memoryPath === 'string'
    ? kernel.graph.memoryPath.trim()
    : '';
  const base = memoryPath
    ? path.dirname(path.resolve(memoryPath))
    : path.join(os.homedir(), '.local', 'state', 'huqan');
  return path.join(base, '.huqan-capability-nonces');
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
}) {
  // #4227 (CWE-863): enforce operator RBAC on HTTP ingest approval routes
  const capabilityNonces = operatorToken
    ? createDurableCapabilityNonceStore({
        directory: ingestApprovalNonceDirectory(kernel),
      })
    : null;

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
      // #4227 (CWE-863): require operator capability for listing approvals
      if (operatorToken && capabilityNonces) {
        const capability = readOperatorCapability(req);
        const args = { limit: 100, workspaceId: 'default' };
        if (!operatorAuthorized(operatorToken, capability, 'huqan.approvals', args, capabilityNonces)) {
          writeApiError(req, res, 403, 'OPERATOR_AUTH_REQUIRED',
            `A scoped operator capability is required. Present it in ${OPERATOR_CAPABILITY_HEADER}.`);
          return true;
        }
      }
      try {
        approvalRuntime.recover();
        const limit = Math.min(100, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 50));
        const workspaceId = sanitizeInput(
          reqUrl.searchParams.get('workspaceId') || 'default',
          128,
        ) || 'default';
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
      // #4227 (CWE-863): require operator capability for deciding approvals
      if (operatorToken && capabilityNonces) {
        const capability = readOperatorCapability(req);
        const workspaceId = sanitizeInput(
          reqUrl.searchParams.get('workspaceId') || 'default',
          128,
        ) || 'default';
        const args = { approvalId, workspaceId, decision, reason: String(body.reason || '') };
        if (!operatorAuthorized(operatorToken, capability, 'huqan.approve', args, capabilityNonces)) {
          writeApiError(req, res, 403, 'OPERATOR_AUTH_REQUIRED',
            `A scoped operator capability is required. Present it in ${OPERATOR_CAPABILITY_HEADER}.`);
          return true;
        }
      }
      try {
        const store = approvalRuntime.getStore();
        approvalRuntime.recover(store);
        const outcome = await approvalRuntime.decide({
          approvalId,
          workspaceId: sanitizeInput(
            reqUrl.searchParams.get('workspaceId') || 'default',
            128,
          ) || 'default',
          decision,
          reason: String(body.reason || ''),
        });
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
