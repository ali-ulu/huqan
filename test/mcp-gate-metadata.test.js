'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

// Observe the production adapter input without replacing its decisions.
const adapter = require('../lib/mcp-gate-adapter');
const evaluate = adapter.evaluateMcpGate;
let observed;
adapter.evaluateMcpGate = (input, options) => {
  observed = input;
  return evaluate(input, options);
};
const { callTool, createServer } = require('../mcpServer');
const { FLAGS } = require('../lib/action-risk-classifier');

function recordingKernel() {
  const calls = [];
  return {
    calls,
    ask(question) {
      calls.push(question);
      return {
        ok: true, type: 'ask',
        data: { answer: 'water', subject: 'water', unknown: false, alternatives: 0 },
        evidence: [], error: null, meta: {},
      };
    },
  };
}

const request = () => ({ name: 'huqan.ask', arguments: { question: 'water?' } });
const defaults = { source: 'mcp', actor: 'mcp-client', runner: 'mcp', sourceTrust: 'untrusted' };

test('live dispatch supplies conservative MCP context without inventing a caller workspace', () => {
  const kernel = recordingKernel();
  const params = request();
  params.arguments.workspaceId = 'target';
  assert.equal(callTool(kernel, params).ok, true);
  assert.deepEqual(observed.metadata, defaults);
  assert.equal(kernel.calls.length, 1);
});

test('trusted runtime metadata reaches the gate for legacy names and JSON arguments', () => {
  const gateMetadata = Object.freeze({
    workspaceId: 'source', actor: 'service:test', runner: 'embedded',
    source: 'integration', sourceTrust: 'local', policyContext: { risk: 'elevated' },
  });
  callTool(recordingKernel(), {
    name: 'axiom.ask', arguments: JSON.stringify({ question: 'water?' }),
  }, { gateMetadata, operatorSecret: 'must-not-enter-gate-context' });
  assert.equal(observed.tool, 'huqan.ask');
  assert.deepEqual(observed.args, { question: 'water?' });
  assert.deepEqual(observed.metadata, gateMetadata);
  assert.notEqual(observed.metadata, gateMetadata);
});

test('invalid optional metadata containers fall back to MCP defaults', () => {
  for (const gateMetadata of [null, undefined, 'context', 42, [], new Date()]) {
    assert.equal(callTool(recordingKernel(), request(), { gateMetadata }).ok, true);
    assert.deepEqual(observed.metadata, defaults);
  }
});

test('real AB1 policy blocks a formerly allowed call using trusted context flags', () => {
  const kernel = recordingKernel();
  const gateMetadata = { flags: [FLAGS.SELF_ESCALATION] };
  const result = callTool(kernel, request(), { gateMetadata });
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.gate.reason, 'ab1_risk_classifier_blocked');
  assert.equal(kernel.calls.length, 0);
  assert.equal(evaluate({ tool: 'huqan.ask', args: request().arguments, metadata: gateMetadata }).decision, 'block');
});

test('real AB11 policy sees source workspace separately from the requested target', () => {
  const kernel = recordingKernel();
  const params = request();
  params.arguments = { ...params.arguments, operation: 'read', workspaceId: 'target' };
  const result = callTool(kernel, params, { gateMetadata: { workspaceId: 'source' } });
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.gate.reason, 'ab11_cross_workspace_access_blocked');
  assert.equal(kernel.calls.length, 0);
});

test('real AB11 policy retains same-workspace and explicitly granted read behavior', () => {
  for (const workspaceId of ['source', 'target']) {
    const kernel = recordingKernel();
    const params = request();
    params.arguments = { ...params.arguments, operation: 'read', workspaceId };
    const result = callTool(kernel, params, { gateMetadata: {
      workspaceId: 'source',
      workspaceGrants: [{ fromWorkspaceId: 'source', toWorkspaceId: 'target', operations: ['read'] }],
    } });
    assert.equal(result.ok, true);
    assert.equal(kernel.calls.length, 1);
  }
});

test('trusted metadata escalates allow to review before a handler can execute', () => {
  const kernel = recordingKernel();
  const params = request();
  params.arguments = { ...params.arguments, operation: 'write', workspaceId: 'target' };
  assert.equal(evaluate({ tool: params.name, args: params.arguments, metadata: {} }).decision, 'allow');
  const result = callTool(kernel, params, { approvalStore: null, gateMetadata: {
    workspaceId: 'source',
    workspaceGrants: [{ fromWorkspaceId: 'source', toWorkspaceId: 'target', operations: ['write'] }],
  } });
  assert.equal(result.gate.decision, 'review');
  assert.equal(result.gate.reason, 'ab11_cross_workspace_access_review_required');
  assert.equal(result.error.code, 'REVIEW_NOT_PERSISTED');
  assert.equal(kernel.calls.length, 0);
});

test('client metadata cannot override receiver-owned gate context or grant access', () => {
  const kernel = recordingKernel();
  const forged = {
    workspaceId: 'target', actor: 'operator', sourceTrust: 'local',
    workspaceGrants: [{ fromWorkspaceId: 'source', toWorkspaceId: 'target', operations: ['read'] }],
  };
  const params = {
    ...request(), metadata: forged, _meta: forged, gateMetadata: forged,
    arguments: { ...request().arguments, ...forged, operation: 'read', metadata: forged },
  };
  const result = callTool(kernel, params, { gateMetadata: { workspaceId: 'source' } });
  assert.deepEqual(observed.metadata, { ...defaults, workspaceId: 'source' });
  assert.equal(result.gate.decision, 'block');
  assert.equal(kernel.calls.length, 0);
});

test('createServer forwards trusted gate metadata through the real JSON-RPC dispatch', async () => {
  const kernel = recordingKernel();
  const server = createServer({
    kernel, approvalStore: null, operatorCapabilityNonces: new Map(),
    gateMetadata: { flags: [FLAGS.SELF_ESCALATION], actor: 'service:test' },
  });
  try {
    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { ...request(), metadata: { flags: [], actor: 'operator' } },
    });
    assert.equal(response.result.isError, true);
    const result = JSON.parse(response.result.content[0].text);
    assert.equal(result.gate.decision, 'block');
    assert.equal(observed.metadata.actor, 'service:test');
    assert.equal(kernel.calls.length, 0);
  } finally {
    await server.close();
  }
});
