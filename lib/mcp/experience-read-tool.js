'use strict';

/**
 * `huqan.experience_read` -- one run's Experience projection, over MCP.
 *
 * Read-only and model-visible like `huqan.status`: the journal holds no
 * secrets beyond its workspace boundary, and the workspace check lives in
 * the shared projection, so there is no capability gate to stand in front
 * of. The journal arrives on the context once the runtime seam wiring
 * (#2378) lands a production instance; until then this module is exercised
 * directly, which is exactly what the parity tests do.
 */

const { sanitizeMcpString } = require('../mcp-input-sanitizers');
const { withMcpToolVerdictSurface } = require('./response-builders');
const { buildExperienceRead } = require('../experience/read-model');

function executeMcpExperienceRead({ journal, name, args, gate }) {
  const safe = args && typeof args === 'object' ? args : {};
  const projection = buildExperienceRead(journal, {
    runId: sanitizeMcpString(safe.runId, 128),
    workspaceId: sanitizeMcpString(safe.workspaceId, 128),
  });
  if (!projection.ok) {
    return withMcpToolVerdictSurface({
      ok: false,
      data: null,
      evidence: [],
      error: { code: 'EXPERIENCE_READ_FAILED', message: projection.code },
      meta: {},
    }, name, args, gate);
  }
  return withMcpToolVerdictSurface({
    ok: true,
    type: 'experience_read',
    data: projection,
    evidence: [],
    error: null,
    meta: {},
  }, name, args, gate);
}

module.exports = { executeMcpExperienceRead };
