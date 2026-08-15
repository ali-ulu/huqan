'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { callTool, createServer } = require('../mcpServer');
const { withMcpToolVerdictSurface } = require('../lib/mcp/response-builders');

test('learn contract explicitly projects only existing candidate, provenance, approval, audit, and receipt values', () => {
  const result = withMcpToolVerdictSurface({
    ok: false,
    type: 'learn',
    data: { learned: 0, skipped: 1, conflicts: [], alternatives: [] },
    approval: { id: 'approval-787', status: 'pending', persisted: true },
    admission: { outcome: 'review', approvalId: 'approval-787', workspaceId: 'team-787' },
    evidence: [],
    error: null,
    meta: {},
  }, 'huqan.learn', {
    workspaceId: 'team-787',
    provenance: { provenanceId: 'prov-787', sourceType: 'document', sourceRef: 'doc:787' },
  }, { decision: 'review', reason: 'mutating_requires_review', requiredReview: true });

  assert.equal(result.candidateId, null);
  assert.deepEqual(result.provenance, {
    present: true, provenanceId: 'prov-787', sourceType: 'document', sourceRef: 'doc:787',
  });
  assert.deepEqual(result.policy, { decision: 'review', reason: 'mutating_requires_review' });
  assert.equal(result.approval.approvalId, 'approval-787');
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.audit, null);
  assert.equal(result.receipt, null);
  assert.equal(result.memoryAdmission.approvalId, 'approval-787');
});

test('learn contract never fabricates candidate, audit, or receipt identifiers from approval input', () => {
  const result = withMcpToolVerdictSurface({
    ok: false,
    type: 'learn',
    approval: { id: 'approval-only', status: 'pending', persisted: true },
    evidence: [], error: null, meta: {},
  }, 'huqan.learn', { text: 'candidate text' }, {
    decision: 'review', reason: 'mutating_requires_review', requiredReview: true,
  });

  assert.equal(result.candidateId, null);
  assert.equal(result.audit, null);
  assert.equal(result.receiptId, null);
  assert.equal(result.receipt, null);
  assert.equal(result.canonicalWrite, false);
});

test('learn direct and transport responses keep approval parity without a canonical write', async () => {
  const approvalStore = {
    saveToolApproval(record) { return record; },
  };
  const kernel = { learn() { throw new Error('reviewed learn must not execute'); } };
  const params = {
    name: 'huqan.learn',
    arguments: {
      text: 'review me', workspaceId: 'team-787',
      provenance: { provenanceId: 'prov-parity', sourceType: 'document', sourceRef: 'doc:parity' },
    },
  };
  const direct = callTool(kernel, params, { approvalStore });
  const transport = await createServer({ kernel, approvalStore }).handleRequest({
    jsonrpc: '2.0', id: 787, method: 'tools/call', params,
  });
  const structured = transport.result.structuredContent;

  for (const result of [direct, structured]) {
    assert.equal(result.status, 'review_required');
    assert.equal(result.approval.persisted, true);
    assert.equal(result.canonicalWrite, false);
    assert.equal(result.candidateId, null);
    assert.equal(result.provenance.provenanceId, 'prov-parity');
    assert.equal(result.audit, null);
    assert.equal(result.receipt, null);
  }
  assert.match(direct.approval.approvalId, /^approval-/);
  assert.match(structured.approval.approvalId, /^approval-/);
  assert.deepEqual(Object.keys(structured).sort(), Object.keys(direct).sort());
});

test('agent contract exposes existing AgentV3 checkpoint identity without advertising repair controls', () => {
  const result = withMcpToolVerdictSurface({
    ok: true, type: 'agent',
    data: {
      goal: 'resume safely', objective: 'resume safely', selectedTools: [], steps: [], evidence: [], status: 'paused', notes: [],
      queuedSteps: [], finalAnswer: 'paused', completedSteps: 0, remainingSteps: 1, report: 'paused',
      resumed: true, checkpointId: 'checkpoint-787', resumeToken: 'checkpoint-787', pauseReason: 'time_budget_exceeded',
      workspaceId: 'team-787', nextAction: null, progress: {},
    },
    evidence: [], error: null, meta: {},
  }, 'huqan.agent', {}, { decision: 'dry_run_only', reason: 'agent_loop_dry_run_only' });

  assert.equal(result.trace.runId, 'checkpoint-787');
  assert.equal(result.data.resumeToken, 'checkpoint-787');

  const tool = createServer({ kernel: {} }).handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    .result.tools.find(entry => entry.name === 'huqan.agent');
  assert.ok(tool.outputSchema.properties.data.anyOf[1].properties.checkpointId);
  assert.ok(tool.outputSchema.properties.data.anyOf[1].properties.resumeToken);
  assert.equal(tool.inputSchema.properties.repair, undefined);
  assert.equal(tool.inputSchema.additionalProperties, false);

  const learn = createServer({ kernel: {} }).handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    .result.tools.find(entry => entry.name === 'huqan.learn');
  for (const field of ['policy', 'approval', 'canonicalWrite', 'candidateId', 'provenance', 'audit', 'receipt', 'receiptId']) {
    assert.ok(learn.outputSchema.properties[field], `${field} must be machine-readable`);
    assert.ok(learn.outputSchema.required.includes(field), `${field} must be explicit on every result`);
  }
});
