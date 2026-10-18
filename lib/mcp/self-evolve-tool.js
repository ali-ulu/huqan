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
const { boundedMcpInteger } = require('../mcp-input-sanitizers');
const { normalizeWorkspaceId } = require('../workspace-id');

function invalidInput(message) {
  return {
    ok: false,
    type: 'fractal_learn_with_self_evolve',
    data: null,
    evidence: [],
    error: { code: 'INVALID_INPUT', message },
    meta: {},
  };
}

function executeMcpSelfEvolve(kernel, name, args, gate) {
  // The canonical rule decides here, at the boundary: a 256-char clip or a
  // control-char strip would accept an id lib/workspace-id.js rejects, or
  // quietly turn it into a different one (#4032). A rejected id is a caller
  // error, so it is answered as INVALID_INPUT rather than an internal error.
  let workspaceId;
  try {
    workspaceId = normalizeWorkspaceId(args.workspaceId);
  } catch (error) {
    return withMcpToolVerdictSurface(invalidInput(error.message), name, args, gate);
  }
  return withMcpToolVerdictSurface(runSelfEvolveAdapter(kernel, {
    depth: boundedMcpInteger(args.depth, 2, 1, 5),
    maxRounds: boundedMcpInteger(args.maxRounds, 5, 1, 20),
    minScore: typeof args.minScore === 'number' ? args.minScore : 0.6,
    entropyFloor: typeof args.entropyFloor === 'number' ? args.entropyFloor : 0.001,
    autoTune: args.autoTune === true,
    workspaceId,
  }), name, args, gate);
}

module.exports = { executeMcpSelfEvolve };
