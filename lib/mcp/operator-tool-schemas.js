'use strict';

// Operator-only MCP tool schemas (#2505 F-2b).
//
// lib/mcp-tool-catalog.js is at its line budget, so the operator tools live
// here and the catalog spreads them in. The catalog stays the serving module:
// TOOL_SCHEMAS is still built there, and tool provenance still names it.

const { buildEnvelopeSchema } = require('../mcp-envelope-schema');
const { AGENT_CONTINUATION_SCHEMA } = require('../mcp-tool-data-schemas');

const OPERATOR_TOOL_SCHEMAS = [
  {
    name: 'huqan.agent_resume',
    title: 'HUQAN Agent Resume / Repair',
    description: 'Operator-only continuation of a paused AgentV3 run. Requires a workspace-scoped checkpoint and exact resume token; repair requires an explicit reason.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', maxLength: 4000 },
        workspaceId: { type: 'string', maxLength: 128 },
        checkpointId: { type: 'string', maxLength: 128 },
        resumeToken: { type: 'string', maxLength: 256 },
        mode: { type: 'string', enum: ['resume', 'repair'] },
        repairReason: { type: 'string', maxLength: 2000 },
        maxSteps: { type: 'integer', minimum: 1, maximum: 8 },
      },
      required: ['goal', 'workspaceId', 'checkpointId', 'resumeToken'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(AGENT_CONTINUATION_SCHEMA),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.emergency_stop',
    title: 'HUQAN Emergency Stop',
    description: 'Operator-only emergency stop. Halt one agent or every agent and MCP tool call in a workspace, check whether a scope is stopped, or lift a stop. Requires a workspace-scoped operator capability; the gate is not evaluated.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stop', 'lift', 'check'] },
        scope: { type: 'string', enum: ['agent', 'workspace'] },
        workspaceId: { type: 'string', maxLength: 128 },
        agentId: { type: 'string', maxLength: 128 },
        reason: { type: 'string', maxLength: 2000 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema({ type: 'object', additionalProperties: true }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

module.exports = {
  OPERATOR_TOOL_SCHEMAS,
};
