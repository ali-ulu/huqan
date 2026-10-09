'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Observe the live input without replacing policy decisions. Each test file
// runs in its own process; dispatch captures this wrapper at require time.
const adapter = require('../lib/mcp-gate-adapter');
const evaluate = adapter.evaluateMcpGate;
let observed;
adapter.evaluateMcpGate = input => {
  observed = input;
  return evaluate(input);
};
const { callTool, createServer } = require('../mcpServer');

function kernelFixture() {
  return {
    calls: 0,
    ask() {
      this.calls += 1;
      return {
        ok: true, type: 'ask',
        data: { answer: 'answer', subject: 'x', unknown: false, alternatives: 0 },
        evidence: [], error: null,
        meta: { contractVersion: '1.0', backend: 'memory', paranoidMode: false },
      };
    },
  };
}

const params = { name: 'huqan.ask', arguments: { question: 'x', workspaceId: 'team-b', operation: 'read' } };
const grant = { fromWorkspaceId: 'team-a', toWorkspaceId: 'team-b', operations: ['read'] };

test('live calls have conservative MCP context without inventing a caller workspace', () => {
  const kernel = kernelFixture();
  const result = callTool(kernel, params);
  assert.equal(result.verdict, 'allow');
  assert.equal(kernel.calls, 1);
  assert.deepEqual(observed.metadata, {
    source: 'mcp', actor: 'mcp-client', runner: 'mcp', sourceTrust: 'unknown',
  });
});

test('host metadata reaches the live gate and enforces cross-workspace denial', () => {
  const kernel = kernelFixture();
  const gateMetadata = Object.freeze({
    workspaceId: 'team-a', actor: 'integration-user', runner: 'integration',
    source: 'integration', sourceTrust: 'local',
  });
  const result = callTool(kernel, params, { gateMetadata });
  assert.deepEqual(observed.metadata, gateMetadata);
  assert.notEqual(observed.metadata, gateMetadata);
  assert.equal(result.verdict, 'block');
  assert.equal(result.policy.reason, 'ab11_cross_workspace_access_blocked');
  assert.equal(kernel.calls, 0);
});

test('host workspace grants permit the same call through the real gate', () => {
  const kernel = kernelFixture();
  const result = callTool(kernel, params, {
    gateMetadata: { workspaceId: 'team-a', workspaceGrants: [grant] },
  });
  assert.equal(result.verdict, 'allow');
  assert.equal(kernel.calls, 1);
});

test('host context escalates a granted cross-workspace write from allow to review', () => {
  const kernel = kernelFixture();
  const writeParams = { ...params, arguments: { ...params.arguments, operation: 'write' } };
  assert.equal(callTool(kernel, writeParams).verdict, 'allow');
  const result = callTool(kernel, writeParams, {
    createStorage: () => null,
    gateMetadata: {
      workspaceId: 'team-a',
      workspaceGrants: [{ ...grant, operations: ['write'] }],
    },
  });
  assert.equal(result.verdict, 'review');
  assert.equal(kernel.calls, 1, 'the reviewed call must not execute the handler');
});

test('wire metadata cannot replace host identity, trust or workspace grants', () => {
  const kernel = kernelFixture();
  const forged = { workspaceId: 'team-b', actor: 'operator', sourceTrust: 'local', workspaceGrants: [grant] };
  const result = callTool(kernel, {
    ...params, metadata: forged, _meta: forged, gateMetadata: forged,
    arguments: { ...params.arguments, metadata: forged, ...forged },
  }, { gateMetadata: { workspaceId: 'team-a', actor: 'real-client' } });
  assert.equal(observed.metadata.actor, 'real-client');
  assert.equal(observed.metadata.sourceTrust, 'unknown');
  assert.equal(observed.metadata.workspaceGrants, undefined);
  assert.equal(result.verdict, 'block');
  assert.equal(kernel.calls, 0);
});

test('legacy tool names and JSON arguments retain the host gate context', () => {
  const kernel = kernelFixture();
  const result = callTool(kernel, {
    name: 'axiom.ask', arguments: JSON.stringify(params.arguments),
  }, { gateMetadata: { workspaceId: 'team-a' } });
  assert.equal(observed.tool, 'huqan.ask');
  assert.equal(result.verdict, 'block');
  assert.equal(kernel.calls, 0);
});

test('createServer forwards host gate context across the JSON-RPC boundary', async t => {
  const kernel = kernelFixture();
  const server = createServer({
    kernel, approvalStore: null, operatorCapabilityNonces: new Map(),
    experienceJournal: null, gateMetadata: { workspaceId: 'team-a' },
  });
  t.after(() => server.close());
  const response = await server.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params,
  });
  assert.equal(response.result.isError, true);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.verdict, 'block');
  assert.equal(result.policy.reason, 'ab11_cross_workspace_access_blocked');
  assert.equal(kernel.calls, 0);
});
