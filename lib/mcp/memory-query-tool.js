'use strict';

/**
 * `huqan.memory_query` -- search memory records by text, over MCP.
 *
 * Read-only and model-visible like `huqan.experience_read`. The workspace
 * boundary, the recall gate and the ranking all live in the shared
 * projection (lib/memory-query-read.js), so this module only adapts its
 * answer to the MCP envelope. Distinct from `huqan.search`, which searches
 * graph nodes rather than memory records.
 */

const { withMcpToolVerdictSurface } = require('./response-builders');
const { buildMemoryQueryRead } = require('../memory-query-read');

function executeMcpMemoryQuery({ memory, name, args, gate }) {
  const result = buildMemoryQueryRead(memory, args);
  if (!result.ok) {
    return withMcpToolVerdictSurface({
      ok: false,
      data: null,
      evidence: [],
      error: { code: 'MEMORY_QUERY_FAILED', message: `${result.code}: ${result.message}` },
      meta: {},
    }, name, args, gate);
  }
  return withMcpToolVerdictSurface({
    ok: true,
    type: 'memory_query',
    data: result,
    evidence: [],
    error: null,
    meta: {},
  }, name, args, gate);
}

module.exports = { executeMcpMemoryQuery };
