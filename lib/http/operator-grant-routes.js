'use strict';

/**
 * Operator grant for Control Room decisions.
 *
 * A learn decision on `POST /api/v2/approvals/{id}/decision` needs a short-lived,
 * scope-bound operator capability (#3926), minted with the operator token. The
 * browser never holds that token, so before this route the Control Room's
 * Approve button could only ever answer 403.
 *
 * This route mints exactly one capability for exactly one decision: tool
 * `huqan.approve`, one approval id, one workspace, one verdict and one reason,
 * valid for at most a minute and spendable once (the decision route consumes
 * its nonce). It never mints anything wider.
 *
 * Two ways to earn it:
 *
 *   ask (default)  the person deciding proves operator authority at the moment
 *                  of the decision by presenting the operator token. The token
 *                  is compared in constant time and never stored or echoed.
 *                  Wrong guesses throttle the route for a while; the throttle
 *                  never refuses the operator's own key.
 *   auto (opt-in)  the operator switched automatic grants on, and the request
 *                  is a direct loopback request. The server then mints without
 *                  asking. Turning auto on needs the operator token once;
 *                  turning it off needs nothing (narrowing is always allowed).
 *
 * Auto is never honoured when:
 *   - the request did not come from loopback, or carries a proxy header
 *     (X-Forwarded-For, Forwarded, X-Real-IP): a local reverse proxy makes a
 *     remote caller look local, so any such header counts as remote;
 *   - the Host header is not a loopback name (DNS rebinding);
 *   - the browser marks the request cross-site, or the Origin is not this
 *     server (another web page posting to localhost);
 *   - an approval authority is installed or required (ADR-016): there the
 *     decision belongs to the OS-separated service and nothing here may stand
 *     in for it.
 *
 * Residual risk, stated rather than hidden: with auto on, any process running
 * as the same OS user can reach loopback and obtain a grant. That process can
 * already read the operator token from the same user's environment, which is
 * why ADR-016 reports this whole mode as `boundary: same-user`. Auto removes a
 * prompt, not a boundary that existed. See ADR-019.
 */

const fs = require('node:fs');
const path = require('node:path');
const { constantTimeEqual } = require('../../requestGuards');
const { createMcpOperatorCapability } = require('../mcp-operator-capability');
const { operatorCapabilityBinding } = require('../mcp/operator-authorization');
const { isLoopbackHost } = require('../api-auth-opt-out');
const { resolveApprovalAuthorityMode } = require('../authority/authority-mode');

const GRANT_PATHNAME = '/api/v2/operator/grant';
const CAPABILITY_PATHNAME = '/api/v2/operator/capabilities';
const CAPABILITY_TTL_MS = 60_000;
const BODY_MAX_BYTES = 4096;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000;
const PROXY_HEADERS = Object.freeze(['x-forwarded-for', 'forwarded', 'x-real-ip']);
const NO_STORE = Object.freeze({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
const MODES = Object.freeze(['ask', 'auto']);

function hostnameOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.replace(/^\[|\]$/g, '');
  } catch (_) {
    return '';
  }
}

/**
 * Whether this request is a direct, same-origin request from this machine.
 * Fail-closed: anything ambiguous answers false.
 */
function isDirectLoopbackRequest(req) {
  const headers = (req && req.headers) || {};
  if (PROXY_HEADERS.some((name) => headers[name] !== undefined)) return false;
  const remote = String(req?.socket?.remoteAddress || '');
  if (!isLoopbackHost(remote)) return false;
  if (!isLoopbackHost(hostnameOf(headers.host))) return false;
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (headers.origin !== undefined) {
    if (String(headers.origin) === 'null') return false;
    if (hostnameOf(headers.origin) !== hostnameOf(headers.host)) return false;
    let originPort = '';
    let hostPort = '';
    try { originPort = new URL(String(headers.origin)).port; } catch (_) { return false; }
    try { hostPort = new URL(`http://${headers.host}`).port; } catch (_) { return false; }
    if (originPort !== hostPort) return false;
  }
  return true;
}

function grantPreferencePath(kernel, explicit) {
  if (explicit) return explicit;
  const memoryPath = kernel && kernel.graph && typeof kernel.graph.memoryPath === 'string'
    ? kernel.graph.memoryPath.trim()
    : '';
  const base = memoryPath ? path.dirname(path.resolve(memoryPath)) : process.cwd();
  return path.join(base, '.huqan-operator-grant.json');
}

function createGrantPreference(filePath) {
  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && parsed.mode === 'auto' ? 'auto' : 'ask';
    } catch (_) {
      return 'ask';
    }
  }
  function write(mode) {
    if (mode === 'ask') {
      fs.rmSync(filePath, { force: true });
      return;
    }
    const temp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ mode, changedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(temp, filePath);
  }
  return Object.freeze({ read, write });
}

function createAttemptLimiter(now) {
  let failures = 0;
  let lockedUntil = 0;
  return Object.freeze({
    locked: () => now() < lockedUntil,
    fail() {
      failures += 1;
      if (failures >= MAX_FAILED_ATTEMPTS) {
        failures = 0;
        lockedUntil = now() + LOCKOUT_MS;
      }
    },
    // The operator's own key ends the lockout and clears the guess counter:
    // the limiter holds nothing the person's correct key would need.
    succeed() { failures = 0; lockedUntil = 0; },
  });
}

function readWorkspace(reqUrl) {
  const raw = String(reqUrl.searchParams.get('workspaceId') || 'default');
  const workspaceId = raw.trim();
  return workspaceId && workspaceId === raw && workspaceId.length <= 128 ? workspaceId : '';
}

function createOperatorGrantRoutes(options = {}) {
  const { kernel, parseJsonRequest, writeJson, getApprovalStore } = options;
  const operatorToken = typeof options.operatorToken === 'string' ? options.operatorToken : '';
  if (!operatorToken) return null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const resolveMode = typeof options.resolveAuthorityMode === 'function'
    ? options.resolveAuthorityMode
    : resolveApprovalAuthorityMode;
  const preference = createGrantPreference(grantPreferencePath(kernel, options.preferencePath));
  const limiter = createAttemptLimiter(now);

  function fail(req, res, status, code, message) {
    writeJson(req, res, status, { ok: false, error: { code, message } }, NO_STORE);
  }

  function legacyAuthority() {
    try {
      return resolveMode().mode === 'legacy';
    } catch (_) {
      return false;
    }
  }

  function autoAllowedFor(req) {
    return isDirectLoopbackRequest(req) && legacyAuthority();
  }

  // Returns null when the token checks out, or the refusal to send.
  // The correct key is always verified and accepted, even while the limiter
  // is locked: this route only requires the transport API key, which the
  // proposing agent holds, so a process-wide lock must not let that agent
  // keep a person out of Control Room decisions (threat #3926). Wrong
  // guesses stay throttled as before.
  function checkToken(presented) {
    if (typeof presented === 'string' && presented && constantTimeEqual(presented, operatorToken)) {
      limiter.succeed();
      return null;
    }
    if (limiter.locked()) return [429, 'OPERATOR_GRANT_LOCKED', 'Too many wrong operator keys. Try again in a few minutes.'];
    if (typeof presented !== 'string' || !presented) {
      return [403, 'OPERATOR_AUTH_REQUIRED', 'Operator approval is required for this decision.'];
    }
    // Only a presented guess counts toward the lockout; a request that
    // simply carries no key is not a guess.
    limiter.fail();
    return [403, 'OPERATOR_AUTH_REQUIRED', 'The operator key was not accepted.'];
  }

  function describe(req) {
    const mode = preference.read();
    const autoAvailable = autoAllowedFor(req);
    return { mode, autoAvailable, autoActive: mode === 'auto' && autoAvailable };
  }

  async function handleGrant(req, res) {
    if (req.method === 'GET') {
      writeJson(req, res, 200, { ok: true, data: describe(req) }, NO_STORE);
      return;
    }
    if (req.method !== 'PUT') {
      fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return;
    }
    const body = await parseJsonRequest(req, res, { maxBytes: BODY_MAX_BYTES });
    if (!body) return;
    const mode = String(body.mode || '');
    if (!MODES.includes(mode)) {
      fail(req, res, 400, 'INVALID_GRANT_MODE', 'mode ask|auto is required.');
      return;
    }
    if (mode === 'auto') {
      if (!autoAllowedFor(req)) {
        fail(req, res, 403, 'OPERATOR_AUTO_GRANT_UNAVAILABLE', 'Automatic approval is only available on this computer.');
        return;
      }
      const refusal = checkToken(body.operatorToken);
      if (refusal) { fail(req, res, ...refusal); return; }
    }
    preference.write(mode);
    writeJson(req, res, 200, { ok: true, data: describe(req) }, NO_STORE);
  }

  function pendingApproval(approvalId, workspaceId) {
    if (typeof getApprovalStore !== 'function') return true;
    try {
      const store = getApprovalStore();
      const row = store && typeof store.getToolApprovalById === 'function'
        ? store.getToolApprovalById(approvalId, workspaceId)
        : null;
      return Boolean(row) && String(row.status || 'pending') === 'pending';
    } catch (_) {
      return false;
    }
  }

  async function handleCapability(req, res, reqUrl) {
    if (req.method !== 'POST') {
      fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return;
    }
    const workspaceId = readWorkspace(reqUrl);
    const body = await parseJsonRequest(req, res, { maxBytes: BODY_MAX_BYTES });
    if (!body) return;
    const approvalId = typeof body.approvalId === 'string' ? body.approvalId : '';
    const decision = String(body.decision || '');
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!workspaceId || !approvalId || approvalId.length > 256 || !['approved', 'rejected'].includes(decision)) {
      fail(req, res, 400, 'INVALID_GRANT_REQUEST', 'approvalId and decision approved|rejected are required.');
      return;
    }
    const auto = preference.read() === 'auto' && autoAllowedFor(req);
    if (!auto) {
      const refusal = checkToken(body.operatorToken);
      if (refusal) { fail(req, res, ...refusal); return; }
    }
    if (!pendingApproval(approvalId, workspaceId)) {
      fail(req, res, 404, 'APPROVAL_NOT_FOUND', 'Approval was not found in this workspace.');
      return;
    }
    const args = { approvalId, workspaceId, decision, reason };
    const capability = createMcpOperatorCapability({
      secret: operatorToken,
      ...operatorCapabilityBinding('huqan.approve', args),
      ttlMs: CAPABILITY_TTL_MS,
      now: now(),
    });
    writeJson(req, res, 200, {
      ok: true,
      data: { capability, grantedBy: auto ? 'auto' : 'operator', expiresInMs: CAPABILITY_TTL_MS },
    }, NO_STORE);
  }

  async function route(req, res, reqUrl) {
    const pathname = String(reqUrl?.pathname || '');
    if (pathname === GRANT_PATHNAME) { await handleGrant(req, res); return true; }
    if (pathname === CAPABILITY_PATHNAME) { await handleCapability(req, res, reqUrl); return true; }
    return false;
  }

  return Object.freeze({ route });
}

/** Mounted like the memory-approval boundary: absent until an operator token exists. */
function createOperatorGrantBoundary(options = {}) {
  const routes = createOperatorGrantRoutes(options);
  return Object.freeze({
    authContext: Object.freeze({ operatorGrantRouteEnabled: routes !== null }),
    async route(req, res, reqUrl) {
      if (!routes) return false;
      return routes.route(req, res, reqUrl);
    },
  });
}

module.exports = Object.freeze({
  GRANT_PATHNAME,
  CAPABILITY_PATHNAME,
  CAPABILITY_TTL_MS,
  isDirectLoopbackRequest,
  createOperatorGrantRoutes,
  createOperatorGrantBoundary,
});
