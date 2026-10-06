'use strict';

// The MCP JSON-RPC methods: initialize, ping, tools/list, tools/call and
// shutdown, and how a failed tools/call is answered (#2142).

const pkg = require('../../package.json');
const { toToolResult, recordInternalError } = require('../mcp-envelope-format');
const {
  describeConfigurationError,
  configurationErrorEnvelope,
  recordConfigurationError,
} = require('../mcp-configuration-errors');
const { MODEL_VISIBLE_TOOL_SCHEMAS, OPERATOR_TOOL_SCHEMAS } = require('./tool-surface');
const { auditToolSurfaceFilter } = require('./tool-surface-filter-audit');

const PROTOCOL_VERSION = '2025-06-18';
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

/** `callTool(params)` runs one tool call and may return a value or a promise. */
function createJsonRpcHandler({ callTool }) {
  return function handleRequest(message) {
    if (!message || typeof message !== 'object') {
      return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } };
    }

    const { id, method, params } = message;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };
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
        if (result && typeof result.then === 'function') {
          return result.then(
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
