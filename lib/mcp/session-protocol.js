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
// How long a cancelled call may run on before its cancellation is receipted
// as unsettled. Long enough for an agent run to finish a step, short enough
// that a hung call does not hold its entry for the life of the session.
const CANCEL_SETTLE_DEADLINE_MS = 60_000;

/**
 * What this server implements of the MCP surface, so a client can read the
 * difference between "advertised" and "absent" instead of probing for it.
 * test/mcp-session-protocol.test.js holds every row to the live handler.
 */
const IMPLEMENTED_SURFACE = Object.freeze({
  protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  tools: Object.freeze({ list: true, call: true, listChanged: false }),
  cancellation: Object.freeze({
    supported: 'advisory',
    scope: 'in-flight asynchronous tools/call',
    effect: 'the response is withheld; work already running is not interrupted and may still commit; a receipt records how the call ended, or that it had not settled by the deadline',
    settleDeadlineMs: CANCEL_SETTLE_DEADLINE_MS,
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
 * Whether a settled call wrote. Only an envelope that states it is believed:
 * a rejected call, or a result without the verdict surface, may have written
 * before it ended, so it is reported as unknown rather than as no write.
 */
function writeState(outcome, result) {
  if (outcome === 'completed' && typeof result.canonicalWrite === 'boolean') return result.canonicalWrite;
  return 'unknown';
}

/**
 * The receipt for a cancelled call. It says how the call ended, not how it
 * was meant to end: a call that wrote before the cancellation arrived reports
 * the write and its receipt id; a call still running at the deadline is
 * `unsettled`, and its write is unknown.
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
    canonicalWrite: writeState(outcome, result),
    receiptId: boundedText(result.receiptId, MAX_CANCEL_REASON),
    errorCode: outcome === 'failed'
      ? boundedText(error && error.code) || 'INTERNAL_ERROR'
      : boundedText(isPlainObject(result.error) ? result.error.code : null),
  };
}

/**
 * Tracks asynchronous tools/call requests so a cancellation can find them.
 *
 * Bounded: a cancelled call that has not settled by `settleDeadlineMs` gets
 * an `unsettled` receipt and leaves the table, so a hung call cannot pin its
 * entry forever or leave the cancellation unrecorded. If it settles later,
 * the true outcome is written under `<operationId>:settled`. A cancelled
 * call is never answered (MCP 2025-06-18: the receiver should not respond).
 *
 * `writeReceipt(operationId, receipt)` must not throw; the caller owns the
 * sink and its failure reporting.
 */
function createCancellationTracker({ sessionId, writeReceipt, settleDeadlineMs = CANCEL_SETTLE_DEADLINE_MS }) {
  const inFlight = new Map();

  function receiptFor(entry, outcome, value, error) {
    return cancellationReceipt({
      sessionId, id: entry.id, tool: entry.tool, reason: entry.reason, outcome, value, error,
    });
  }

  function cancel(params) {
    const key = requestKey(params && params.requestId);
    const entry = key === null ? undefined : inFlight.get(key);
    // Unknown, finished, or never cancellable: MCP lets the receiver ignore
    // it. A repeated cancellation keeps the first reason.
    if (!entry || entry.cancelled) return;
    entry.cancelled = true;
    entry.reason = params.reason;
    entry.deadline = setTimeout(() => {
      inFlight.delete(key);
      entry.receiptWritten = true;
      writeReceipt(entry.operationId, receiptFor(entry, 'unsettled', null, null));
    }, settleDeadlineMs);
    entry.deadline.unref?.();
  }

  function settle(key, entry, outcome, value, error, respond) {
    inFlight.delete(key);
    if (!entry.cancelled) return respond();
    clearTimeout(entry.deadline);
    const operationId = entry.receiptWritten ? `${entry.operationId}:settled` : entry.operationId;
    writeReceipt(operationId, receiptFor(entry, outcome, value, error));
    return null;
  }

  /**
   * Track `pending` for request `id`. `respond(value)` and `fail(err)` build
   * the answer when the call was not cancelled. An id that cannot be keyed,
   * or one already in flight (a client protocol error), is answered but not
   * cancellable.
   */
  function track(id, tool, pending, respond, fail) {
    const key = requestKey(id);
    if (key === null || inFlight.has(key)) return pending.then(respond, fail);
    const entry = {
      id, tool, cancelled: false, reason: null, deadline: null, receiptWritten: false,
      operationId: `mcp:cancellation:${sessionId}:${key}`,
    };
    inFlight.set(key, entry);
    return pending.then(
      value => settle(key, entry, 'completed', value, null, () => respond(value)),
      err => settle(key, entry, 'failed', null, err, () => fail(err)),
    );
  }

  return { cancel, track, inFlightCount: () => inFlight.size };
}

module.exports = Object.freeze({
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  CANCEL_SETTLE_DEADLINE_MS,
  IMPLEMENTED_SURFACE,
  negotiateInitialize,
  requestKey,
  cancellationReceipt,
  createCancellationTracker,
});
