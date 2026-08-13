'use strict';

const crypto = require('crypto');

function prettyEnvelope(result) {
  if (!result) return 'No result.';
  if (result.ok === false && result.error) {
    return `${result.error.code}: ${result.error.message}`;
  }
  return JSON.stringify(result, null, 2);
}

function toToolResult(result) {
  return {
    content: [{ type: 'text', text: prettyEnvelope(result) }],
    structuredContent: result,
    isError: Boolean(result && result.ok === false),
  };
}

/**
 * Records an unexpected exception and returns a short reference for it.
 *
 * The client gets the reference, never the exception. `err.message` on an
 * uncaught throw carries whatever the failing layer happened to say --
 * filesystem paths, SQLite errors, internal identifiers -- and an MCP client
 * is not a trusted operator console.
 *
 * The detail goes to stderr, which is the right sink for a stdio server: the
 * protocol owns stdout, so diagnostics cannot be written there without
 * corrupting the stream. Logging is itself wrapped, because a failure while
 * reporting a failure must not replace the response the caller is waiting for.
 */
function recordInternalError(scope, err) {
  const errorRef = crypto.randomBytes(4).toString('hex');
  try {
    console.error(`[mcp][${scope}] internal error ref=${errorRef}`, err);
  } catch (_) {
    // Diagnostics are best-effort; the bounded response below is not.
  }
  return errorRef;
}

module.exports = {
  prettyEnvelope,
  toToolResult,
  recordInternalError,
};
