'use strict';

/**
 * MCP session protocol: initialize negotiation, the implemented-surface
 * table, and the cancellation receipt (#3484).
 *
 * Version policy. MCP 2025-06-18 lifecycle: a server that supports the
 * client's requested version answers with it; otherwise it answers with a
 * version it does support, and the client decides whether to continue. A
 * mismatch is therefore not an error here. The supported list holds only
 * what this server implements and tests; claiming an older handshake
 * version (2024-11-05, 2025-03-26) or the stateless modern era would need
 * those wire rules verified first, so a client asking for one is answered
 * with 2025-06-18 and the mismatch is recorded, not refused.
 *
 * Client capabilities are read and reported, never trusted for authority:
 * this server does not use roots, sampling or elicitation, and the table
 * below says so.
 */

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18']);
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const MAX_CLIENT_TEXT = 128;
const MAX_CANCEL_REASON = 256;

/**
 * What this server implements of the MCP surface, so a client can read the
 * difference between "advertised" and "absent" instead of probing for it.
 * test/mcp-session-protocol.test.js holds every row to the live handler.
 */
const IMPLEMENTED_SURFACE = Object.freeze({
  protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  tools: Object.freeze({ list: true, call: true, listChanged: false }),
  cancellation: Object.freeze({
    supported: true,
    scope: 'in-flight asynchronous tools/call',
    effect: 'the response is withheld and a receipt records how the call ended; work already running is never interrupted mid-write',
  }),
  progress: false,
  resources: false,
  prompts: false,
  logging: false,
  completions: false,
  clientFeaturesUsed: Object.freeze({ roots: false, sampling: false, elicitation: false }),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, max = MAX_CLIENT_TEXT) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function readClientCapabilities(capabilities) {
  const declared = isPlainObject(capabilities) ? capabilities : {};
  return {
    roots: isPlainObject(declared.roots),
    rootsListChanged: isPlainObject(declared.roots) && declared.roots.listChanged === true,
    sampling: isPlainObject(declared.sampling),
    elicitation: isPlainObject(declared.elicitation),
  };
}

/**
 * Negotiate an initialize request. Never throws and never refuses: the
 * answer is the requested version when supported, otherwise the latest
 * supported one, with the request recorded beside it.
 */
function negotiateInitialize(params) {
  const request = isPlainObject(params) ? params : {};
  const requestedVersion = boundedText(request.protocolVersion, 32);
  const matched = requestedVersion !== null && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion);
  const clientInfo = isPlainObject(request.clientInfo) ? request.clientInfo : {};
  return {
    protocolVersion: matched ? requestedVersion : LATEST_PROTOCOL_VERSION,
    requestedVersion,
    matched,
    clientInfo: { name: boundedText(clientInfo.name), version: boundedText(clientInfo.version) },
    clientCapabilities: readClientCapabilities(request.capabilities),
  };
}

/** The cancellable key of a JSON-RPC id, or null when it cannot be one. */
function requestKey(id) {
  if (typeof id === 'string' && id.length > 0 && id.length <= MAX_CLIENT_TEXT) return `s:${id}`;
  if (Number.isSafeInteger(id)) return `n:${id}`;
  return null;
}

/**
 * The receipt for a cancelled call, written after the call settled. It says
 * how the call ended, not how it was meant to end: a call that wrote before
 * the cancellation arrived reports the write and its receipt id.
 */
function cancellationReceipt({ sessionId, id, tool, reason, outcome, value, error }) {
  const result = isPlainObject(value) ? value : {};
  return {
    kind: 'mcp.tools_call.cancelled',
    sessionId,
    requestId: id,
    tool: boundedText(tool),
    reason: boundedText(reason, MAX_CANCEL_REASON),
    outcome,
    canonicalWrite: result.canonicalWrite === true,
    receiptId: boundedText(result.receiptId, MAX_CANCEL_REASON),
    errorCode: outcome === 'failed'
      ? boundedText(error && error.code) || 'INTERNAL_ERROR'
      : boundedText(isPlainObject(result.error) ? result.error.code : null),
  };
}

module.exports = Object.freeze({
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  IMPLEMENTED_SURFACE,
  negotiateInitialize,
  requestKey,
  cancellationReceipt,
});
