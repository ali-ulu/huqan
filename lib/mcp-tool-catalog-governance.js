'use strict';

// #2186: MCP tool schemas for policy, approvals, approval detail and approve, in catalog order. lib/mcp-tool-catalog.js
// concatenates the domain arrays back into TOOL_SCHEMAS.

const {
  buildEnvelopeSchema,
} = require('./mcp-envelope-schema');
const {
  TOOL_POLICY_SCHEMA,
  TOOL_APPROVAL_SCHEMA,
  APPROVAL_DECISION_DATA_SCHEMA,
} = require('./mcp-tool-data-schemas');

const GOVERNANCE_TOOL_SCHEMAS = [
  {
    name: 'huqan.policy',
    title: 'HUQAN Tool Policy',
    description: 'Inspect whether a requested tool is internal, review-only, or blocked, and return a safe execution policy summary.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name to inspect, for example: "browser.open" or "shell".' },
        input: { type: 'string', description: 'Optional tool input or command text.' },
        goal: { type: 'string', description: 'Optional higher-level goal for context.' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(TOOL_POLICY_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.approvals',
    title: 'HUQAN Approval Queue',
    description: 'List pending tool approvals and review queue items that were created by the tool policy layer.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of approval entries to return.' },
        workspaceId: { type: 'string', minLength: 1, maxLength: 128, description: 'Workspace whose approval queue may be read.' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(TOOL_APPROVAL_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.approval_detail',
    title: 'HUQAN Approval Detail',
    // The counterpart to huqan.approvals: that tool returns a bounded window of
    // unresolved rows, this one opens the approval whose id huqan.learn already
    // handed the caller -- including one that has since been resolved.
    description: 'Read one tool approval by its approval id, workspace-scoped.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', minLength: 1, maxLength: 128, description: 'Workspace that owns the approval.' },
        approvalId: { type: 'string', minLength: 1, maxLength: 256, description: 'Approval id, as returned by huqan.learn or huqan.approvals.' },
      },
      required: ['workspaceId', 'approvalId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(TOOL_APPROVAL_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.approve',
    title: 'HUQAN Approve',
    description: 'Approve or reject a pending MCP tool approval. Approved MCP learn requests execute once through the normal admission-aware kernel.learn path.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string', description: 'Pending approval id returned by huqan.learn or huqan.approvals.' },
        decision: { type: 'string', enum: ['approved', 'rejected'], description: 'Approval decision. Defaults to approved.' },
        reason: { type: 'string', description: 'Optional human-readable decision reason.' },
        workspaceId: { type: 'string', minLength: 1, maxLength: 128, description: 'Workspace that owns the approval.' },
      },
      required: ['approvalId', 'workspaceId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(APPROVAL_DECISION_DATA_SCHEMA),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

module.exports = { GOVERNANCE_TOOL_SCHEMAS };
