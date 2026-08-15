'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer, callTool, OPERATOR_TOOL_SCHEMAS } = require('../mcpServer');
const { WORKFLOW_CONTRACT_VERSION } = require('../lib/workflow-contract');
const { withMcpToolVerdictSurface } = require('../lib/mcp/response-builders');

function kernel() {
  return {
    ask() {
      return {
        ok: true,
        type: 'ask',
        data: { answer: 'answer', subject: 'subject', unknown: false, alternatives: 0 },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0.0', backend: 'fixture', paranoidMode: false },
      };
    },
  };
}

test('model-visible MCP discovery reuses the workflow manifest without exposing operator tools', () => {
  const response = createServer({ kernel: kernel(), approvalStore: null }).handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
  });
  const tools = response.result.tools;
  assert.ok(tools.length > 0);
  assert.equal(tools.some(tool => tool.name === 'huqan.approve' || tool.name === 'huqan.approvals'), false);
  for (const tool of tools) {
    assert.match(tool.metadata.workflow.workflowId, /^[a-z][a-z0-9-]*$/);
    assert.equal(tool.metadata.workflow.version, WORKFLOW_CONTRACT_VERSION);
    assert.match(tool.inputSchema.$id, new RegExp(`\\.${WORKFLOW_CONTRACT_VERSION.replaceAll('.', '\\.')}$`));
    assert.match(tool.outputSchema.$id, new RegExp(`\\.${WORKFLOW_CONTRACT_VERSION.replaceAll('.', '\\.')}$`));
    assert.deepEqual(Object.keys(tool.metadata.workflow.counterparts).sort(), ['api', 'cli', 'ui']);
  }
  assert.deepEqual(OPERATOR_TOOL_SCHEMAS.map(tool => tool.name).sort(), ['huqan.approvals', 'huqan.approve']);
  assert.ok(OPERATOR_TOOL_SCHEMAS.every(tool => tool.metadata.workflow.version === WORKFLOW_CONTRACT_VERSION));
});

test('MCP results explicitly distinguish a completed read from canonical mutation', () => {
  const result = callTool(kernel(), { name: 'huqan.ask', arguments: { question: 'question' } });
  assert.equal(result.workflowId, 'ask');
  assert.equal(result.version, WORKFLOW_CONTRACT_VERSION);
  assert.equal(result.status, 'completed');
  assert.equal(result.canonicalWrite, false);
  assert.deepEqual(result.policy, { decision: 'allow', reason: 'read_only_allow' });
  assert.equal(result.approval, null);
  assert.equal(result.receiptId, null);
  assert.equal(result.trace, null);
  assert.equal(result.confidence, null);
});

test('operator authorization failures use the same fail-closed workflow envelope', () => {
  const result = callTool(kernel(), {
    name: 'huqan.approve',
    arguments: { approvalId: 'approval-1' },
  }, { operatorToken: 'configured' });
  assert.equal(result.ok, false);
  assert.equal(result.workflowId, 'approval-decision');
  assert.equal(result.status, 'blocked');
  assert.equal(result.policy.decision, 'block');
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.error.code, 'OPERATOR_AUTH_REQUIRED');
});

test('approved writes project the committed receipt owned by the nested learn result', () => {
  const result = withMcpToolVerdictSurface({
    ok: true,
    type: 'approval',
    data: {
      executed: true,
      approval: { id: 'approval-1', status: 'approved' },
      result: { ok: true, data: { learned: 1 }, meta: { committedReceiptId: 'receipt-committed-1' } },
    },
    evidence: [],
    error: null,
    meta: {},
  }, 'huqan.approve', {}, { decision: 'allow', reason: 'operator_authorized' });

  assert.equal(result.canonicalWrite, true);
  assert.equal(result.receiptId, 'receipt-committed-1');
  assert.equal(result.toolVerdict.receiptId, 'receipt-committed-1');
});

test('review without durable persistence is failed, never review_required', () => {
  const result = withMcpToolVerdictSurface({
    ok: false,
    type: 'learn',
    approval: { persisted: false, notPersistedReason: 'approval_store_unavailable' },
    error: { code: 'REVIEW_NOT_PERSISTED', message: 'Nothing was queued.' },
    evidence: [],
    meta: {},
  }, 'huqan.learn', {}, { decision: 'review', reason: 'mutating_requires_review', requiredReview: true });

  assert.equal(result.status, 'failed');
  assert.notEqual(result.status, 'review_required');
  assert.equal(result.memoryAdmission.status, 'blocked');
  assert.equal(result.approval.persisted, false);
  assert.equal(result.canonicalWrite, false);
});

test('plan and run identities live in the workflow trace without changing domain data', () => {
  const domainResult = {
    ok: true,
    type: 'plan',
    data: {
      goal: 'verify this',
      objective: 'verify',
      maxSteps: 1,
      selectedTools: ['verify'],
      steps: [{ id: 'verify', action: 'verify', tool: 'verify', input: 'verify this' }],
    },
    evidence: [],
    error: null,
    meta: {},
  };
  const gate = { decision: 'allow', reason: 'read_only_allow' };
  const canonical = withMcpToolVerdictSurface(domainResult, 'huqan.plan', {}, gate);
  const legacy = withMcpToolVerdictSurface(domainResult, 'axiom.plan', {}, gate);

  assert.deepEqual(canonical.data, domainResult.data);
  assert.deepEqual(legacy.data, canonical.data);
  assert.match(canonical.trace.planId, /^plan-[0-9a-f]{64}$/);
  assert.equal(legacy.trace.planId, canonical.trace.planId);
  assert.equal(canonical.trace.steps[0].inputDigest.length, 64);

  const runDomain = {
    ...domainResult,
    type: 'agent',
    data: { checkpointId: 'checkpoint-stable', plan: domainResult.data, steps: [], status: 'paused' },
  };
  const run = withMcpToolVerdictSurface(runDomain, 'huqan.agent', {}, gate);
  assert.deepEqual(run.data, runDomain.data);
  assert.equal(run.trace.runId, 'checkpoint-stable');
  assert.equal(run.trace.traceId, 'checkpoint-stable');
  assert.equal(run.trace.planId, canonical.trace.planId);
});
