'use strict';

/**
 * HTTP approval for memory admissions.
 *
 * `POST /upload` produces a pending memory admission with a provenance id and
 * a review receipt, and no HTTP route could resolve it. `/api/ingest/approvals`
 * and `/api/v2/approvals` both filter `tool === 'http.ingest'`, so an admission
 * from /upload was invisible to every approval surface this server has. An HTTP
 * client could propose and never approve; the only way through was the CLI.
 *
 * ## Why this needs its own credential
 *
 * The obvious fix -- serve it behind HUQAN_API_KEY like every other route --
 * would let whoever can propose a memory write also approve it. That collapses
 * the separation the review gate exists to create, and it is the same
 * separation mcpServer.js enforces by withholding huqan.approve from
 * `tools/list` and gating it on HUQAN_MCP_OPERATOR_TOKEN. A governance product
 * must not offer self-approval on one surface and refuse it on another.
 *
 * So this route requires both: the API key that authenticates the transport,
 * and a short-lived, scope-bound operator capability that authorizes the
 * decision, presented in `x-huqan-operator-capability`. Configuring the API key
 * alone does not create an approval path.
 *
 * Following the shape /api/a2a/exchange and the external-client route already
 * use, the route does not exist until the operator token is configured. An
 * unconfigured deployment answers 404 rather than 401, so a missing
 * configuration does not advertise a surface it will refuse.
 *
 * ## Why it delegates
 *
 * Deciding an approval materializes a canonical write, a receipt and an audit
 * event. Reimplementing that here would create a second executor to keep in
 * step with the first, and the first is the one the conformance evidence
 * covers. This calls the same huqan.approvals / huqan.approve tools the CLI
 * calls, so the semantics, gating and receipts are the tested ones by
 * construction rather than by review.
 */

const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const {
  operatorCapabilityBinding,
  verifyMcpOperatorCapability,
} = require('../../mcpServer');

const OPERATOR_CAPABILITY_HEADER = 'x-huqan-operator-capability';
const LIST_PATHNAME = '/api/v2/memory-approvals';
const DECISION_PATTERN = /^\/api\/v2\/memory-approvals\/([^/]+)\/decision$/;
const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const DECISION_BODY_MAX_BYTES = 4096;

/**
 * The capability verifier performs HMAC verification with a constant-time
 * signature comparison and then checks the tool/workspace/action binding. The
 * nonce store makes a capability one-use at this HTTP boundary.
 */
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

function isMemoryApprovalPath(pathname) {
  const raw = String(pathname || '');
  return raw === LIST_PATHNAME || DECISION_PATTERN.test(raw);
}

/**
 * @returns {null|{route: Function}} null when no operator token is configured,
 *   which is what keeps the surface a 404 rather than a refusal.
 */
function createMemoryApprovalRoutes(options = {}) {
  const {
    kernel,
    approvalRuntime,
    parseJsonRequest,
    writeJson,
  } = options;

  const operatorToken = options.operatorToken !== undefined
    ? options.operatorToken
    : (readCompatibleEnvironmentVariable('MCP_OPERATOR_TOKEN') || '');
  if (!operatorToken || !kernel) return null;
  const capabilityNonces = new Map();

  // Deferred, like lib/a2a/exchange-route.js defers its evaluator: requiring
  // the MCP server at module load would pull it into every consumer of this
  // file, including ones that will never configure an operator token.
  const callTool = typeof options.callTool === 'function'
    ? options.callTool
    // eslint-disable-next-line global-require
    : require('../../mcpServer').callTool;

  function fail(req, res, statusCode, code, message) {
    writeJson(req, res, statusCode, {
      ok: false, status: 'failed', error: { code, message },
    }, NO_STORE);
  }

  async function route(req, res, reqUrl) {
    const pathname = String(reqUrl?.pathname || '');
    const decisionMatch = pathname.match(DECISION_PATTERN);
    if (pathname !== LIST_PATHNAME && !decisionMatch) return false;

    const expectedMethod = decisionMatch ? 'POST' : 'GET';
    if (req.method !== expectedMethod) {
      fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }

    const workspaceId = String(reqUrl.searchParams.get('workspaceId') || 'default').trim();
    if (!decisionMatch) {
      const limit = Math.min(50, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 50));
      const args = { limit, workspaceId };
      const capability = readOperatorCapability(req);
      // Checked before anything reads the store, so an unauthorized caller
      // cannot learn whether an approval id exists by timing or status code.
      if (!operatorAuthorized(operatorToken, capability, 'huqan.approvals', args)) {
        fail(req, res, 403, 'OPERATOR_AUTH_REQUIRED',
          `A scoped operator capability is required. Present it in ${OPERATOR_CAPABILITY_HEADER}.`);
        return true;
      }
      const runtime = {
        ...(typeof approvalRuntime === 'function' ? approvalRuntime() : {}),
        operatorSecret: operatorToken,
        operatorCapabilityNonces: capabilityNonces,
      };
      const result = await callTool(kernel, {
        name: 'huqan.approvals', operatorCapability: capability, arguments: args,
      }, runtime);
      writeJson(req, res, result && result.ok === false ? 400 : 200, result, NO_STORE);
      return true;
    }

    let approvalId;
    try { approvalId = decodeURIComponent(decisionMatch[1]); } catch (_) { approvalId = ''; }
    if (!approvalId) {
      fail(req, res, 400, 'APPROVAL_ID_REQUIRED', 'approvalId is required.');
      return true;
    }

    const body = await parseJsonRequest(req, res, { maxBytes: DECISION_BODY_MAX_BYTES });
    if (!body) return true;

    const decision = String(body.decision || '').trim().toLowerCase();
    const args = { approvalId, workspaceId, decision, reason: String(body.reason || '') };
    const capability = readOperatorCapability(req);
    // The body is parsed before this check so the capability can bind the exact
    // decision and reason, while no approval store state has been touched.
    if (!operatorAuthorized(operatorToken, capability, 'huqan.approve', args)) {
      fail(req, res, 403, 'OPERATOR_AUTH_REQUIRED',
        `A scoped operator capability is required. Present it in ${OPERATOR_CAPABILITY_HEADER}.`);
      return true;
    }
    if (!['approved', 'rejected'].includes(decision)) {
      fail(req, res, 400, 'INVALID_APPROVAL_DECISION', 'decision approved|rejected is required.');
      return true;
    }

    const runtime = {
      ...(typeof approvalRuntime === 'function' ? approvalRuntime() : {}),
      operatorSecret: operatorToken,
      operatorCapabilityNonces: capabilityNonces,
    };
    const result = await callTool(kernel, {
      name: 'huqan.approve', operatorCapability: capability, arguments: args,
    }, runtime);
    writeJson(req, res, result && result.ok === false ? 400 : 200, result, NO_STORE);
    return true;
  }

  return Object.freeze({ route });
}

/**
 * The single mount point, mirroring lib/a2a/routes.js.
 *
 * The composite always exists so server.js keeps one line and no null check,
 * and publishes its own `authContext` entry so adding a route here never edits
 * server.js again -- the file-size ledger in scripts/check-file-size.js exists
 * to prevent exactly that drift.
 */
function createMemoryApprovalBoundary(options = {}) {
  const routes = createMemoryApprovalRoutes(options);
  return Object.freeze({
    authContext: Object.freeze({ memoryApprovalRouteEnabled: routes !== null }),
    async route(req, res, reqUrl) {
      if (!routes) return false;
      return routes.route(req, res, reqUrl);
    },
  });
}

module.exports = Object.freeze({
  OPERATOR_CAPABILITY_HEADER,
  OPERATOR_TOKEN_HEADER: OPERATOR_CAPABILITY_HEADER,
  LIST_PATHNAME,
  isMemoryApprovalPath,
  operatorAuthorized,
  createMemoryApprovalRoutes,
  createMemoryApprovalBoundary,
});
