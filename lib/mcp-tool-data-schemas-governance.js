'use strict';

// #2172: data schemas for system status, compliance audit, tool policy,
// tool approval, approval decisions and the advocate.

const SYSTEM_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    nodes: { type: 'integer', minimum: 0 },
    edges: { type: 'integer', minimum: 0 },
    entropy: { type: 'number' },
    gaps: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'object' } },
    agentRuntime: { type: ['string', 'null'] },
  },
  required: ['nodes', 'edges', 'entropy'],
  additionalProperties: true,
};

// The report's own shape is owned by lib/cli-audit.js and versioned by
// schemaVersion; pinning every article here would duplicate that ownership and
// go stale the first time an article gains a control.
const COMPLIANCE_AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string' },
    framework: { type: 'string' },
    workspaceId: { type: 'string' },
    articles: { type: 'object' },
  },
  required: ['schemaVersion', 'articles'],
  additionalProperties: true,
};

const TOOL_POLICY_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    input: { type: 'string' },
    category: { type: 'string', enum: ['internal', 'external'] },
    action: { type: 'string', enum: ['allow', 'review', 'block'] },
    approval: { type: 'string', enum: ['auto', 'review', 'blocked'] },
    blocked: { type: 'boolean' },
    requiresApproval: { type: 'boolean' },
    review: { type: 'boolean' },
    riskScore: { type: 'integer', minimum: 0, maximum: 100 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    labels: { type: 'array', items: { type: 'string' } },
    reasons: { type: 'array', items: { type: 'string' } },
    suggestedNextStep: { type: 'string' },
    source: { type: 'string' },
    context: { type: 'object' },
    approvalId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    approvalStatus: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['tool', 'category', 'action', 'approval', 'blocked', 'requiresApproval', 'labels', 'reasons'],
  additionalProperties: true,
};

const TOOL_APPROVAL_SCHEMA = {
  type: 'object',
  properties: {
    pendingCount: { type: 'integer', minimum: 0 },
    unresolvedCount: { type: 'integer', minimum: 0 },
    approvals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          approvalKey: { type: 'string' },
          tool: { type: 'string' },
          input: { type: 'string' },
          status: { type: 'string' },
          decision: { type: 'string' },
          reason: { type: 'string' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
          policy: { type: 'object' },
          context: { type: 'object' },
        },
        required: ['id', 'approvalKey', 'tool', 'status', 'decision', 'reason', 'createdAt', 'updatedAt'],
        additionalProperties: true,
      },
    },
  },
  required: ['pendingCount', 'approvals'],
  additionalProperties: true,
};

const APPROVAL_DECISION_DATA_SCHEMA = {
  type: 'object',
  properties: {
    approval: { type: 'object' },
    decision: { type: 'string' },
    executed: { type: 'boolean' },
    idempotent: { type: 'boolean' },
    result: { type: 'object' },
  },
  required: ['approval', 'decision', 'executed', 'idempotent'],
  additionalProperties: true,
};

const ADVOCATE_DATA_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    counterArguments: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
};

module.exports = {
  ADVOCATE_DATA_SCHEMA,
  APPROVAL_DECISION_DATA_SCHEMA,
  COMPLIANCE_AUDIT_SCHEMA,
  SYSTEM_STATUS_SCHEMA,
  TOOL_APPROVAL_SCHEMA,
  TOOL_POLICY_SCHEMA,
};
