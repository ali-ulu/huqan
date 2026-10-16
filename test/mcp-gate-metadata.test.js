'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// Observe the production input while retaining every real gate decision.
const adapter = require('../lib/mcp-gate-adapter');
const evaluateMcpGate = adapter.evaluateMcpGate;
let observed;
adapter.evaluateMcpGate = (input) => {
  observed = input;
  return evaluateMcpGate(input);
};
const { callTool, createServer } = require('../mcpServer');

function recordingKernel() {
  return {
    calls: 0,
    ask() {
      this.calls += 1;
      return {
        ok: true, type: 'ask',
        data: { answer: 'water', subject: 'water', unknown: false, alternatives: 0 },
        evidence: [], error: null, meta: {},
      };
    },
  };
}

const defaults = { source: 'mcp', actor: 'mcp-client', runner: 'mcp', sourceTrust: 'unknown' };
const request = (args = {}) => ({ name: 'huqan.ask', arguments: { question: 'water', operation: 'read', ...args } });

function serverCall(t, gateMetadata, params) {
  const kernel = recordingKernel();
  const server = createServer({ kernel, gateMetadata, approvalStore: null, operatorCapabilityNonces: new Map() });
  t.after(() => server.close());
  const response = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
  return { kernel, result: response.result.structuredContent };
}

test('live dispatch supplies conservative MCP context without inventing a workspace identity', () => {
  const kernel = recordingKernel();
  assert.equal(callTool(kernel, request({ workspaceId: 'target' })).ok, true);
  assert.deepEqual(observed.metadata, defaults);
  assert.equal(kernel.calls, 1);
});

test('server-owned metadata reaches the live gate, including custom policy context', (t) => {
  const gateMetadata = Object.freeze({
    workspaceId: 'team-a', actor: 'integration-user', runner: 'integration',
    source: 'integration', sourceTrust: 'untrusted', riskContext: { score: 80 },
  });
  const { result } = serverCall(t, gateMetadata, request({ workspaceId: 'team-a' }));
  assert.equal(result.ok, true);
  assert.deepEqual(observed.metadata, gateMetadata);
  assert.notEqual(observed.metadata, gateMetadata, 'dispatch must build its own metadata record');
});

test('direct callTool hosts can supply the same gate context as createServer', () => {
  const kernel = recordingKernel();
  const result = callTool(kernel, request({ workspaceId: 'team-b' }), {
    gateMetadata: { workspaceId: 'team-a' }, approvalStore: null,
  });
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.gate.reason, adapter.MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_BLOCKED);
  assert.equal(kernel.calls, 0);
});

test('JSON-RPC cross-workspace calls are blocked before the handler executes', (t) => {
  const { result, kernel } = serverCall(t, { workspaceId: 'team-a' }, request({ workspaceId: 'team-b' }));
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.gate.reason, adapter.MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_BLOCKED);
  assert.equal(kernel.calls, 0);
});

test('host grants allow cross-workspace reads but escalate writes to review', (t) => {
  const gateMetadata = {
    workspaceId: 'team-a',
    workspaceGrants: [{ fromWorkspaceId: 'team-a', toWorkspaceId: 'team-b', operations: ['read', 'write'] }],
  };
  const read = serverCall(t, gateMetadata, request({ workspaceId: 'team-b', operation: 'read' }));
  assert.equal(read.result.ok, true);
  assert.equal(read.kernel.calls, 1);
  const write = serverCall(t, gateMetadata, request({ workspaceId: 'team-b', operation: 'update' }));
  assert.equal(write.result.gate.decision, 'review');
  assert.equal(write.result.gate.reason, adapter.MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_REVIEW);
  assert.equal(write.kernel.calls, 0);
});

test('caller metadata cannot override the host workspace or grant itself access', (t) => {
  const forged = { workspaceId: 'team-b', actor: 'operator', sourceTrust: 'trusted',
    workspaceGrants: [{ fromWorkspaceId: 'team-a', toWorkspaceId: 'team-b', operations: ['read'] }] };
  const params = {
    ...request({ ...forged, metadata: forged, gateMetadata: forged }),
    metadata: forged, _meta: forged, gateMetadata: forged,
  };
  const { result, kernel } = serverCall(t, { workspaceId: 'team-a' }, params);
  assert.deepEqual(observed.metadata, { ...defaults, workspaceId: 'team-a' });
  assert.equal(result.gate.decision, 'block');
  assert.equal(kernel.calls, 0);
});

test('missing or non-record host metadata retains conservative defaults', (t) => {
  for (const gateMetadata of [undefined, null, 'trusted', [], 42]) {
    const { result } = serverCall(t, gateMetadata, request());
    assert.equal(result.ok, true);
    assert.deepEqual(observed.metadata, defaults);
  }
});

test('legacy tool aliases use the same metadata path and policy enforcement', (t) => {
  const params = { ...request({ workspaceId: 'team-b' }), name: 'axiom.ask' };
  const { result, kernel } = serverCall(t, { workspaceId: 'team-a' }, params);
  assert.equal(observed.tool, 'huqan.ask');
  assert.equal(result.gate.decision, 'block');
  assert.equal(kernel.calls, 0);
});
