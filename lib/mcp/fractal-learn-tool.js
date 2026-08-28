'use strict';

// MCP dispatch for huqan.fractal-learn. Kept out of mcpServer.js to respect
// the 800-line file-size ceiling (issue #328): the tool logic lives in
// lib/fractal-learn.js, this module only adapts args and wraps the verdict.

const { FractalLearn } = require('../fractal-learn');
const { withMcpToolVerdictSurface } = require('./response-builders');
const { MCP_MAX_SHORT, sanitizeMcpString, boundedMcpInteger } = require('../mcp-input-sanitizers');

function executeMcpFractalLearn(kernel, name, args, gate) {
  return withMcpToolVerdictSurface(new FractalLearn(kernel).run({
    depth: boundedMcpInteger(args.depth, 2, 1, 5),
    maxRounds: boundedMcpInteger(args.maxRounds, 5, 1, 20),
    minScore: typeof args.minScore === 'number' ? args.minScore : 0.6,
    entropyFloor: typeof args.entropyFloor === 'number' ? args.entropyFloor : 0.001,
    workspaceId: sanitizeMcpString(args.workspaceId, MCP_MAX_SHORT) || 'default',
  }), name, args, gate);
}

module.exports = { executeMcpFractalLearn };
