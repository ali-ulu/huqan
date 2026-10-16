'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mcpToolPolicy, DECISION_VIEWS } = require('../lib/mcp-tool-policy');

test('decision views are an exact public policy vocabulary', () => {
  assert.deepEqual(DECISION_VIEWS, {
    allow: {
      action: 'allow',
      approval: 'auto',
      blocked: false,
      requiresApproval: false,
      review: false,
      riskScore: 0,
      labels: ['huqan-mcp-tool', 'read-only'],
      reason: 'read_only_allow',
      detail: 'Read-only HUQAN MCP tool.',
      nextStep: 'No additional action required.',
      executionMode: 'direct',
    },
    review: {
      action: 'review',
      approval: 'review',
      blocked: false,
      requiresApproval: true,
      review: true,
      riskScore: 35,
      labels: ['huqan-mcp-tool', 'mutating', 'requires-approval'],
      reason: 'mutating_requires_review',
      detail: 'Mutating HUQAN MCP tool; a canonical write needs an approval.',
      nextStep: 'Call the operator-only huqan.approve to resolve the approval.',
      executionMode: 'direct',
    },
    dry_run_only: {
      action: 'dry_run_only',
      approval: 'dry-run',
      blocked: false,
      requiresApproval: false,
      review: false,
      riskScore: 20,
      labels: ['huqan-mcp-tool', 'agent-loop', 'dry-run-only'],
      reason: 'agent_loop_dry_run_only',
      detail: 'HUQAN agent loop; runs dry-run only over MCP.',
      nextStep: 'Inspect the dry-run plan; it performs no canonical write.',
      executionMode: 'dry-run',
    },
  });
});

test('policy projection preserves every allow field and MCP classification field', () => {
  assert.deepEqual(mcpToolPolicy('huqan.plan'), {
    tool: 'huqan.plan',
    category: 'internal',
    action: 'allow',
    approval: 'auto',
    blocked: false,
    requiresApproval: false,
    review: false,
    riskScore: 0,
    confidence: 1,
    labels: ['huqan-mcp-tool', 'read-only'],
    reasons: ['Read-only HUQAN MCP tool.', 'Gate decision: read_only_allow.'],
    suggestedNextStep: 'No additional action required.',
    source: 'mcpToolPolicy',
    executionMode: 'direct',
    sandbox: null,
    mcp: {
      known: true,
      mutating: false,
      surfaceCategory: 'read',
      gateDecision: 'allow',
      gates: ['AB1', 'AB11'],
    },
  });
});

test('policy projection preserves write and dry-run MCP metadata', () => {
  const review = mcpToolPolicy('huqan.learn');
  assert.deepEqual(review, {
    tool: 'huqan.learn',
    category: 'internal',
    action: 'review',
    approval: 'review',
    blocked: false,
    requiresApproval: true,
    review: true,
    riskScore: 35,
    confidence: 1,
    labels: ['huqan-mcp-tool', 'mutating', 'requires-approval'],
    reasons: [
      'Mutating HUQAN MCP tool; a canonical write needs an approval.',
      'Gate decision: mutating_requires_review.',
    ],
    suggestedNextStep: 'Call the operator-only huqan.approve to resolve the approval.',
    source: 'mcpToolPolicy',
    executionMode: 'direct',
    sandbox: null,
    mcp: {
      known: true,
      mutating: true,
      surfaceCategory: 'write',
      gateDecision: 'review',
      gates: ['AB1', 'AB2', 'AB4', 'AB11'],
    },
  });

  const dryRun = mcpToolPolicy('huqan.agent');
  assert.equal(dryRun.tool, 'huqan.agent');
  assert.equal(dryRun.action, 'dry_run_only');
  assert.equal(dryRun.approval, 'dry-run');
  assert.equal(dryRun.riskScore, 20);
  assert.equal(dryRun.executionMode, 'dry-run');
  assert.deepEqual(dryRun.labels, ['huqan-mcp-tool', 'agent-loop', 'dry-run-only']);
  assert.deepEqual(dryRun.mcp, {
    known: true,
    mutating: false,
    surfaceCategory: 'agent-loop',
    gateDecision: 'dry_run_only',
    gates: ['AB1', 'AB2', 'AB5', 'AB8', 'AB9', 'AB11'],
  });
});
