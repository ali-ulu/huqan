'use strict';

// The MCP JSON-RPC methods: initialize, ping, tools/list, tools/call,
// notifications/cancelled and shutdown, and how a failed tools/call is
// answered (#2142, #3484).

const crypto = require('node:crypto');

const pkg = require('../../package.json');
const { toToolResult, recordInternalError } = require('../mcp-envelope-format');
const {
  describeConfigurationError,
  configurationErrorEnvelope,
  recordConfigurationError,
} = require('../mcp-configuration-errors');
const { MODEL_VISIBLE_TOOL_SCHEMAS, OPERATOR_TOOL_SCHEMAS } = require('./tool-surface');
const { auditToolSurfaceFilter } = require('./tool-surface-filter-audit');
const {
  LATEST_PROTOCOL_VERSION,
  IMPLEMENTED_SURFACE,
  negotiateInitialize,
  requestKey,
  cancellationReceipt,
} = require('./session-protocol');

const PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;
// RFC-001 decision 1: HUQAN is the canonical product identity. This is the
// name a Claude Desktop / Cursor user sees for the server itself.
const SERVER_NAME = 'huqan';
const SERVER_VERSION = pkg.version;

/**
 * A failed `tools/call`, answered as either a configuration limit or a fault.
 *
 * A deterministic misconfiguration used to be indistinguishable from a crash
 * here: both became `INTERNAL_ERROR (ref: …)`, and the sentence that would fix
 * the former reached only the server's own stderr. See
 * lib/mcp-configuration-errors.js for which codes qualify and why relaying
 * them does not reopen #413.
 */
function toolCallFailure(err) {
  const configuration = describeConfigurationError(err);
  if (configuration) {
    recordConfigurationError('tools/call', configuration.code);
    return toToolResult(configurationErrorEnvelope(configuration));
  }
  const errorRef = recordInternalError('tools/call', err);
  return { content: [{ type: 'text', text: `INTERNAL_ERROR (ref: ${errorRef})` }], isError: true };
}

/**
 * `callTool(params)` runs one tool call and may return a value or a promise.
 * `recordCancellation(operationId, receipt)` persists the receipt of a
 * cancelled call once it settled; without it a cancellation is still
 * honoured and the receipt goes to stderr.
 */
function createJsonRpcHandler({ callTool, recordCancellation = null }) {
  const sessionId = crypto.randomUUID();
  // Asynchronous tools/call requests still running, by request id. A
  // synchronous call has already answered before a cancellation can arrive.
  const inFlight = new Map();

  function cancel(params) {
    const key = requestKey(params && params.requestId);
    const entry = key === null ? undefined : inFlight.get(key);
    // Unknown, finished, or never cancellable: MCP lets the receiver ignore it.
    if (!entry || entry.cancelled) return;
    entry.cancelled = true;
    entry.reason = params.reason;
  }

  function writeReceipt(key, receipt) {
    try {
      if (typeof recordCancellation !== 'function') throw new Error('no cancellation receipt sink');
      recordCancellation(`mcp:cancellation:${sessionId}:${key}`, receipt);
    } catch (err) {
      recordInternalError('notifications/cancelled', Object.assign(err, { receipt }));
    }
  }

  // Settles a tracked call. A cancelled call gets no response (MCP: the
  // receiver should not answer a cancelled request); it gets a receipt that
  // says how it actually ended.
  function settle(key, entry, outcome, value, error, respond) {
    inFlight.delete(key);
    if (!entry.cancelled) return respond();
    writeReceipt(key, cancellationReceipt({
      sessionId, id: entry.id, tool: entry.tool, reason: entry.reason, outcome, value, error,
    }));
    return null;
  }

  function trackToolCall(id, params, pending) {
    const key = requestKey(id);
    if (key === null || inFlight.has(key)) {
      return pending.then(
        value => ({ jsonrpc: '2.0', id, result: toToolResult(value) }),
        err => ({ jsonrpc: '2.0', id, result: toolCallFailure(err) }),
      );
    }
    const entry = { id, tool: params && params.name, cancelled: false, reason: null };
    inFlight.set(key, entry);
    return pending.then(
      value => settle(key, entry, 'completed', value, null,
        () => ({ jsonrpc: '2.0', id, result: toToolResult(value) })),
      err => settle(key, entry, 'failed', null, err,
        () => ({ jsonrpc: '2.0', id, result: toolCallFailure(err) })),
    );
  }

  return function handleRequest(message) {
    if (!message || typeof message !== 'object') {
      return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } };
    }

    const { id, method, params } = message;

    if (method === 'initialize') {
      const negotiation = negotiateInitialize(params);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiation.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          // `_meta` is MCP-reserved result metadata: what was asked for, what
          // the client declared, and what this server implements (#3484).
          _meta: {
            negotiation: {
              requestedVersion: negotiation.requestedVersion,
              matched: negotiation.matched,
              clientInfo: negotiation.clientInfo,
              clientCapabilities: negotiation.clientCapabilities,
            },
            implementedSurface: IMPLEMENTED_SURFACE,
          },
        },
      };
    }

    if (method === 'notifications/cancelled') {
      cancel(params);
      return null;
    }

    if (method === 'notifications/initialized') {
      return null;
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      // `_meta` is MCP-reserved response metadata: the advertised `tools`
      // array is untouched, while the response also carries the filter audit
      // record (tool + allow/block + reason, #3482) so a model can read why
      // a tool is absent instead of meeting silence.
      const filterAudit = auditToolSurfaceFilter({
        visibleSchemas: MODEL_VISIBLE_TOOL_SCHEMAS,
        operatorSchemas: OPERATOR_TOOL_SCHEMAS,
      });
      return { jsonrpc: '2.0', id, result: { tools: MODEL_VISIBLE_TOOL_SCHEMAS, _meta: { filterAudit } } };
    }

    if (method === 'tools/call') {
      try {
        const result = callTool(params);
        if (result && typeof result.then === 'function') return trackToolCall(id, params, result);
        return { jsonrpc: '2.0', id, result: toToolResult(result) };
      } catch (err) {
        return { jsonrpc: '2.0', id, result: toolCallFailure(err) };
      }
    }

    if (method === 'shutdown') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  };
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_NAME,
  createJsonRpcHandler,
};
