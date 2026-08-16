'use strict';

/**
 * The capability negotiation route (P0-D): `POST /api/a2a/negotiate`.
 *
 * Transport only. Every agreement decision belongs to
 * `./capability-negotiation`, and this module's whole job is to move bytes and
 * refuse on the same terms the exchange route refuses on.
 *
 * It is gated on the same configuration as the rest of the A2A surface even
 * though negotiation itself never reads the authority. The reason is the same
 * one that gates the Agent Card: the only capability this receiver can agree to
 * is `bounded-exchange`, and agreeing to it on a deployment where
 * `/api/a2a/exchange` answers 404 would be an agreement the receiver cannot
 * honour. A negotiator that can promise an absent route is worse than no
 * negotiator.
 *
 * Note the status code for a failed negotiation: 409, not 403. No overlap
 * between two capability sets is not an authorization failure and should not
 * read as one -- the caller was allowed to ask, and the honest answer is that
 * there is nothing in common.
 */

const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { readJsonBody } = require('../../requestGuards');
const { writeJson } = require('../server-response-helpers');
const { CANONICAL_WORKSPACE, MAX_BODY_BYTES } = require('./exchange-route');
const { NEGOTIATION } = require('./agent-card');
const { negotiateCapabilities, NEGOTIATION_ERRORS } = require('./capability-negotiation');

// Taken from the card rather than declared here: the document a caller reads to
// find this route and the route itself must not be able to disagree.
const A2A_NEGOTIATE_PATH = NEGOTIATION.path;

const NEGOTIATE_ROUTE_ERRORS = Object.freeze({
  METHOD: 'a2a_negotiate_method_not_allowed',
  BODY: 'a2a_request_body_invalid',
  WORKSPACE: 'a2a_workspace_not_canonical',
});

function createNegotiateBoundary(options = {}) {
  const configured = options.authorityFile !== undefined || options.replayDirectory !== undefined;
  const authorityFile = configured
    ? (options.authorityFile || '')
    : (readCompatibleEnvironmentVariable('A2A_AUTHORITY_FILE') || '');
  const replayDirectory = configured
    ? (options.replayDirectory || '')
    : (readCompatibleEnvironmentVariable('A2A_REPLAY_DIR') || '');
  if (!authorityFile || !replayDirectory) return null;

  return Object.freeze({ path: A2A_NEGOTIATE_PATH, handle, route });

  async function route(req, res, reqUrl) {
    if (reqUrl.pathname !== A2A_NEGOTIATE_PATH) return false;
    const descriptor = await handle(req, readJsonBody);
    writeJson(req, res, descriptor.statusCode, descriptor.body, { 'Cache-Control': 'no-store' });
    return true;
  }

  async function handle(req, readBody) {
    if (String(req.method || '').toUpperCase() !== 'POST') {
      return refusal(405, NEGOTIATE_ROUTE_ERRORS.METHOD);
    }

    let read;
    try {
      read = await readBody(req, { maxBytes: MAX_BODY_BYTES });
    } catch (_) {
      return refusal(400, NEGOTIATE_ROUTE_ERRORS.BODY);
    }
    if (!read || read.ok !== true) {
      return refusal(Number(read && read.status) || 400, NEGOTIATE_ROUTE_ERRORS.BODY);
    }
    const body = read.data;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return refusal(400, NEGOTIATE_ROUTE_ERRORS.BODY);
    }

    // Same promise the exchange route makes: P0 serves the canonical workspace
    // only, and a non-default request is refused before any work happens.
    if (body.workspaceId !== undefined && body.workspaceId !== CANONICAL_WORKSPACE) {
      return refusal(400, NEGOTIATE_ROUTE_ERRORS.WORKSPACE);
    }

    const result = negotiateCapabilities(body);
    if (result.decision !== 'allow') {
      // A malformed request is the caller's error (400); having nothing in
      // common is a well-formed request with no agreement (409).
      const statusCode = result.reason === NEGOTIATION_ERRORS.SHAPE ? 400 : 409;
      return refusal(statusCode, result.reason);
    }
    return Object.freeze({
      statusCode: 200,
      body: Object.freeze({
        decision: 'allow',
        reason: result.reason,
        agreement: result.agreement,
      }),
    });
  }
}

function refusal(statusCode, reason) {
  return Object.freeze({
    statusCode,
    body: Object.freeze({ decision: 'block', reason }),
  });
}

module.exports = Object.freeze({
  A2A_NEGOTIATE_PATH,
  NEGOTIATE_ROUTE_ERRORS,
  createNegotiateBoundary,
});
