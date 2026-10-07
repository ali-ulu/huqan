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
const { outputConformanceSurface } = require('./output-conformance-gate');
const {
  LATEST_PROTOCOL_VERSION,
  IMPLEMENTED_SURFACE,
  negotiateInitialize,
  createCancellationTracker,
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
 * cancelled call; when it is missing or fails, the receipt goes to stderr
 * and the cancellation still holds.
 */
function createJsonRpcHandler({ callTool, recordCancellation = null, cancelSettleDeadlineMs } = {}) {
  const sessionId = crypto.randomUUID();

  function writeReceipt(operationId, receipt) {
    const unwritten = (err) => {
      const failure = new Error(`cancellation receipt not written: ${err && err.message}`);
      failure.receipt = receipt;
      recordInternalError('notifications/cancelled', failure);
    };
    try {
      if (typeof recordCancellation !== 'function') throw new Error('no cancellation receipt sink');
      const written = recordCancellation(operationId, receipt);
      if (written && typeof written.then === 'function') written.then(null, unwritten);
    } catch (err) {
      unwritten(err);
    }
  }

  const cancellations = createCancellationTracker({ sessionId, writeReceipt, settleDeadlineMs: cancelSettleDeadlineMs });

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
      cancellations.cancel(params);
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
      // a tool is absent instead of meeting silence. `outputConformance`
      // names which advertised output schemas tools/call enforces (#3483).
      const filterAudit = auditToolSurfaceFilter({
        visibleSchemas: MODEL_VISIBLE_TOOL_SCHEMAS,
        operatorSchemas: OPERATOR_TOOL_SCHEMAS,
      });
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MODEL_VISIBLE_TOOL_SCHEMAS, _meta: { filterAudit, outputConformance: outputConformanceSurface() } },
      };
    }

    if (method === 'tools/call') {
      try {
        const result = callTool(params);
        if (result && typeof result.then === 'function') {
          return cancellations.track(
            id,
            params && params.name,
            result,
            value => ({ jsonrpc: '2.0', id, result: toToolResult(value) }),
            err => ({ jsonrpc: '2.0', id, result: toolCallFailure(err) }),
          );
        }
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
