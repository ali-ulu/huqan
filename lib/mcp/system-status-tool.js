'use strict';

/**
 * `huqan.status` -- what state is this graph in, over MCP.
 *
 * The question an operator asks right after a tool call ("did that land? how
 * many nodes now? any contradictions?") was answerable only from the CLI, and
 * only as a printed sentence. This returns the report itself, so a client does
 * not parse prose to find a number.
 *
 * Read-only and model-visible: unlike the approval tools there is nothing here
 * that a capability gate needs to stand in front of.
 */

const { buildSystemStatus } = require('../system-status-report');
const { withMcpToolVerdictSurface } = require('./response-builders');

function executeMcpSystemStatus({ kernel, name, args, gate }) {
  return withMcpToolVerdictSurface({
    ok: true,
    type: 'system_status',
    data: buildSystemStatus(kernel),
    evidence: [],
    error: null,
    meta: {},
  }, name, args, gate);
}

module.exports = { executeMcpSystemStatus };
