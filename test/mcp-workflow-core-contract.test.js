'use strict';
const { isolatedKernelOptions, isolatedGraphOptions } = require('./helpers/isolated-persistence');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer, callTool, OPERATOR_TOOL_SCHEMAS } = require('../mcpServer');
const { WORKFLOW_CONTRACT_VERSION } = require('../lib/workflow-contract');
const { withMcpToolVerdictSurface } = require('../lib/mcp/response-builders');
const Kernel = require('../kernel');

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
  assert.equal(tools.some(tool => ['huqan.approve', 'huqan.approvals', 'huqan.agent_resume'].includes(tool.name)), false);
  for (const tool of tools) {
    assert.match(tool.metadata.workflow.workflowId, /^[a-z][a-z0-9-]*$/);
    assert.equal(tool.metadata.workflow.version, WORKFLOW_CONTRACT_VERSION);
    assert.match(tool.inputSchema.$id, new RegExp(`\\.${WORKFLOW_CONTRACT_VERSION.replaceAll('.', '\\.')}$`));
    assert.match(tool.outputSchema.$id, new RegExp(`\\.${WORKFLOW_CONTRACT_VERSION.replaceAll('.', '\\.')}$`));
    assert.deepEqual(Object.keys(tool.metadata.workflow.counterparts).sort(), ['api', 'cli', 'ui']);
  }
  assert.deepEqual(OPERATOR_TOOL_SCHEMAS.map(tool => tool.name).sort(), ['huqan.agent_resume', 'huqan.approvals', 'huqan.approve']);
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

test('MCP discovery publishes advocate, search, and trust-read from the canonical manifest', () => {
  const tools = createServer({ kernel: kernel(), approvalStore: null }).handleRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
  }).result.tools;
  const reads = new Map(tools
    .filter(tool => ['huqan.advocate', 'huqan.search', 'huqan.trust_receipt'].includes(tool.name))
    .map(tool => [tool.name, tool]));

  assert.deepEqual([...reads.keys()].sort(), ['huqan.advocate', 'huqan.search', 'huqan.trust_receipt']);
  assert.deepEqual([...reads.values()].map(tool => tool.metadata.workflow.workflowId).sort(), [
    'advocate', 'memory-search', 'trust-receipt',
  ]);
  assert.ok([...reads.values()].every(tool => tool.metadata.workflow.authRequired === true));
  assert.ok([...reads.values()].every(tool => tool.metadata.workflow.workspaceRequired === true));
  assert.ok([...reads.values()].every(tool => tool.annotations.readOnlyHint === true));
});

test('MCP advocate and search reuse read workflows and fail closed without workspace identity', async () => {
  const readKernel = {
    graph: {
      getNodes(workspaceId) {
        assert.equal(workspaceId, 'team-a');
        return { alpha: { label: 'Alpha', provenance: { sourceRef: 'doc:alpha', provenanceId: 'prov-alpha' } } };
      },
    },
    async runCapability(name, input) {
      assert.equal(name, 'devilAdvocate');
      assert.deepEqual(input, { text: 'alpha is safe', workspaceId: 'default' });
      return { ok: true, data: { mode: 'counter', counterArguments: ['check alpha'] }, evidence: [] };
    },
  };

  const advocate = await callTool(readKernel, {
    name: 'huqan.advocate', arguments: { workspaceId: 'default', claim: 'alpha is safe' },
  });
  const search = await callTool(readKernel, {
    name: 'huqan.search', arguments: { workspaceId: 'team-a', query: 'alpha' },
  });
  const missingWorkspace = await callTool(readKernel, {
    name: 'huqan.search', arguments: { query: 'alpha' },
  });

  assert.equal(advocate.workflowId, 'advocate');
  assert.equal(advocate.data.counterArguments[0], 'check alpha');
  assert.equal(search.workflowId, 'memory-search');
  assert.equal(search.data.items[0].provenanceId, 'prov-alpha');
  assert.equal(search.canonicalWrite, false);
  assert.equal(missingWorkspace.ok, false);
  assert.equal(missingWorkspace.status, 'failed');
  assert.equal(missingWorkspace.error.code, 'INVALID_INPUT');

  const transport = await createServer({ kernel: readKernel, approvalStore: null }).handleRequest({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'huqan.advocate', arguments: { workspaceId: 'default', claim: 'alpha is safe' } },
  });
  assert.equal(transport.id, 3);
  assert.equal(transport.result.structuredContent.workflowId, 'advocate');
  assert.equal(transport.result.structuredContent.status, 'completed');
});

test('MCP trust-read reuses the canonical receipt projection and requires scoped filters', () => {
  const trustKernel = new Kernel(isolatedKernelOptions('mcp-workflow-core-contract', { noLoad: true, useSQLite: false, loadPlugins: false }));
  try {
    trustKernel.learn('kedi hayvandir', {
      workspaceId: 'team-a',
      admissionRequired: true,
      approvalRequired: true,
      approvalStatus: 'approved',
      approvalId: 'approval-mcp-trust-read',
      provenance: {
        provenanceId: 'prov-mcp-read', sourceRef: 'doc:mcp-read', sourceType: 'document',
        actor: 'test', timestamp: '2026-08-15T00:00:00Z', confidence: 0.9,
        workspaceId: 'team-a', trustPolicyVersion: 'test',
      },
    });

    const result = callTool(trustKernel, {
      name: 'huqan.trust_receipt', arguments: { workspaceId: 'team-a', targetId: 'kedi' },
    });
    const unscoped = callTool(trustKernel, {
      name: 'huqan.trust_receipt', arguments: { workspaceId: 'team-a' },
    });

    assert.equal(result.workflowId, 'trust-receipt');
    assert.equal(result.data.workspaceId, 'team-a');
    assert.equal(result.data.provenance.provenanceId, 'prov-mcp-read');
    assert.equal(result.receiptId, result.data.receiptId);
    assert.equal(result.canonicalWrite, false);
    assert.equal(unscoped.ok, false);
    assert.equal(unscoped.error.code, 'INVALID_INPUT');
  } finally {
    trustKernel.close?.();
  }
});
