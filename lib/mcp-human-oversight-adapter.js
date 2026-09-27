'use strict';

// The MCP human oversight adapter (#2207), split by responsibility behind
// this frozen facade (#2306): input building in mcp-oversight-input, the
// receiver-owned agent identity gate in mcp-oversight-identity and the
// review-case plumbing in mcp-oversight-cases. Consumers keep importing
// the whole adapter from here.

const {
  CASE_PREFIX,
  buildMcpOversightInput,
  buildApproverContext,
} = require('./mcp-oversight-input');
const {
  identityEvidence,
  evaluateMcpAgentIdentity,
} = require('./mcp-oversight-identity');
const {
  oversightSummary,
  getHumanOversightRuntime,
  createMcpOversightCase,
  readMcpOversightCase,
  decideMcpOversight,
} = require('./mcp-oversight-cases');

module.exports = Object.freeze({
  CASE_PREFIX,
  buildMcpOversightInput,
  buildApproverContext,
  createMcpOversightCase,
  decideMcpOversight,
  evaluateMcpAgentIdentity,
  getHumanOversightRuntime,
  identityEvidence,
  oversightSummary,
  readMcpOversightCase,
});

// Keep the adapter's identity context surface intentionally narrow: it accepts
// receiver-supplied context, never request payload identity claims.

