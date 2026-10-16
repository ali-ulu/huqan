'use strict';

// MCP dispatch for huqan.self-evolve. Kept out of mcpServer.js to respect
// the 800-line file-size ceiling (issue #328): the tool logic lives in
// lib/self-evolve-adapter.js, this module only adapts args and wraps the verdict.
//
// The adapter runs the L4 fractal-learn loop and then a measured self-evolution
// pass, so this tool is strictly more mutating than huqan.fractal-learn: it can
// move graph content and the thresholds that produce it. The gate adapter
// classifies it accordingly, and the probe's verdict is reported verbatim so a
// caller can tell content-only runs from ones that rewrote the process.

const { runSelfEvolveAdapter } = require('../self-evolve-adapter');
const { withMcpToolVerdictSurface } = require('./response-builders');
const { MCP_MAX_SHORT, sanitizeMcpString, boundedMcpInteger } = require('../mcp-input-sanitizers');

function executeMcpSelfEvolve(kernel, name, args, gate) {
  return withMcpToolVerdictSurface(runSelfEvolveAdapter(kernel, {
    depth: boundedMcpInteger(args.depth, 2, 1, 5),
    maxRounds: boundedMcpInteger(args.maxRounds, 5, 1, 20),
    minScore: typeof args.minScore === 'number' ? args.minScore : 0.6,
    entropyFloor: typeof args.entropyFloor === 'number' ? args.entropyFloor : 0.001,
    autoTune: args.autoTune === true,
    workspaceId: sanitizeMcpString(args.workspaceId, MCP_MAX_SHORT) || 'default',
  }), name, args, gate);
}

module.exports = { executeMcpSelfEvolve };
