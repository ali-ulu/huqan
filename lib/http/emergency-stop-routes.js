'use strict';

/**
 * HTTP operator surface for the emergency stop (#2505 F).
 *
 *   GET  /api/v2/emergency-stops?workspaceId=&agentId=
 *        whether that workspace or agent is stopped
 *   POST /api/v2/emergency-stops
 *        { action: 'stop' | 'lift', scope: 'agent' | 'workspace',
 *          workspaceId, agentId, reason }
 *
 * Stopping or releasing an agent must not be available to whoever holds the API
 * key, so this follows the memory approval route: the API key authenticates the
 * transport, and a short-lived operator capability bound to the exact arguments
 * authorizes the call, presented in `x-huqan-operator-capability`. Without a
 * configured operator token the route does not exist and answers 404.
 *
 * The ledger itself writes the stop record and its receipt
 * (lib/emergency-stop.js), so this surface adds no second writer.
 */

const path = require('node:path');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { operatorCapabilityBinding } = require('../mcp/operator-authorization');
const { verifyMcpOperatorCapability } = require('../mcp-operator-capability');
const { createDurableCapabilityNonceStore } = require('../mcp-capability-nonce-store');
const { emergencyStopLedger, checkArguments, changeArguments } = require('../emergency-stop');

const OPERATOR_CAPABILITY_HEADER = 'x-huqan-operator-capability';
const EMERGENCY_STOP_PATHNAME = '/api/v2/emergency-stops';
const EMERGENCY_STOP_TOOL = 'huqan.emergency_stop';
const BODY_MAX_BYTES = 4096;
const OPERATOR_ACTOR = 'operator:http';
const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function operatorAuthorized(secret, capability, args, nonceStore) {
  if (typeof secret !== 'string' || !secret || typeof capability !== 'string' || !capability) return false;
  return verifyMcpOperatorCapability({
    secret,
    capability,
    expected: operatorCapabilityBinding(EMERGENCY_STOP_TOOL, args),
    nonceStore,
  }).ok === true;
}

/**
 * @returns {null|{route: Function}} null when no operator token is configured.
 */
function createEmergencyStopRoutes(options = {}) {
  const operatorToken = options.operatorToken !== undefined
    ? options.operatorToken
    : (readCompatibleEnvironmentVariable('MCP_OPERATOR_TOKEN') || '');
  if (!operatorToken) return null;
  const { parseJsonRequest, writeJson } = options;
  const ledger = emergencyStopLedger({ emergencyStop: options.emergencyStop, environment: options.environment });
  // Consumed capability nonces live on disk (#3005). A process-local Map made
  // "single-use" true only until the next restart, so a capability spent
  // before a redeploy or reload was replayable inside its five-minute window.
  // The store is atomic across concurrent workers and fails closed.
  const capabilityNonces = options.capabilityNonces
    || createDurableCapabilityNonceStore({
      directory: options.capabilityNonceDir
        || path.join(ledger.directory, 'capability-nonces'),
    });

  function fail(req, res, statusCode, code, message) {
    writeJson(req, res, statusCode, { ok: false, status: 'failed', error: { code, message } }, NO_STORE);
  }

  function refuseUnauthorized(req, res) {
    fail(req, res, 403, 'OPERATOR_AUTH_REQUIRED',
      `A scoped operator capability is required. Present it in ${OPERATOR_CAPABILITY_HEADER}.`);
  }

  async function route(req, res, reqUrl) {
    if (String(reqUrl?.pathname || '') !== EMERGENCY_STOP_PATHNAME) return false;
    const capability = typeof req?.headers?.[OPERATOR_CAPABILITY_HEADER] === 'string'
      ? req.headers[OPERATOR_CAPABILITY_HEADER]
      : '';

    if (req.method === 'GET') {
      const args = checkArguments({
        workspaceId: reqUrl.searchParams.get('workspaceId'),
        agentId: reqUrl.searchParams.get('agentId'),
      });
      if (!operatorAuthorized(operatorToken, capability, args, capabilityNonces)) {
        refuseUnauthorized(req, res);
        return true;
      }
      writeJson(req, res, 200, { ok: true, status: 'completed', data: ledger.check(args) }, NO_STORE);
      return true;
    }

    if (req.method !== 'POST') {
      fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }

    const body = await parseJsonRequest(req, res, { maxBytes: BODY_MAX_BYTES });
    if (!body) return true;
    const args = changeArguments(body);
    // Authorized before anything touches the ledger, over the exact arguments.
    if (!operatorAuthorized(operatorToken, capability, args, capabilityNonces)) {
      refuseUnauthorized(req, res);
      return true;
    }
    if (args.action !== 'stop' && args.action !== 'lift') {
      fail(req, res, 400, 'INVALID_ACTION', 'action stop|lift is required.');
      return true;
    }
    try {
      const result = ledger[args.action]({
        scope: args.scope,
        workspaceId: args.workspaceId,
        agentId: args.agentId || undefined,
        reason: args.reason,
        actor: OPERATOR_ACTOR,
      });
      writeJson(req, res, 200, { ok: true, status: 'completed', data: result }, NO_STORE);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      fail(req, res, 400, 'INVALID_INPUT', error.message);
    }
    return true;
  }

  return Object.freeze({ route });
}

/** The composite mounted by lib/http/optional-boundaries.js. */
function createEmergencyStopBoundary(options = {}) {
  const routes = createEmergencyStopRoutes(options);
  return Object.freeze({
    authContext: Object.freeze({ emergencyStopRouteEnabled: routes !== null }),
    async route(req, res, reqUrl) {
      if (!routes) return false;
      return routes.route(req, res, reqUrl);
    },
  });
}

module.exports = Object.freeze({
  EMERGENCY_STOP_PATHNAME,
  EMERGENCY_STOP_TOOL,
  OPERATOR_CAPABILITY_HEADER,
  changeArguments,
  checkArguments,
  createEmergencyStopBoundary,
  createEmergencyStopRoutes,
});
