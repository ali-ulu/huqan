'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, createKernelFromEnv } = require('../mcpServer');

const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

// Dogfood integration test: agent routes decisions through MCP gate
// This simulates a real AI agent calling HUQAN before acting.

function createDogfoodClient(server) {
  return {
    callTool(tool, args) {
      const request = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: tool, arguments: args },
      };
      const rpcResponse = server.handleRequest(request);
      return rpcResponse.result ? rpcResponse.result.structuredContent || rpcResponse.result : rpcResponse;
    },
    listTools() {
      const request = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/list',
      };
      const rpcResponse = server.handleRequest(request);
      return rpcResponse.result ? rpcResponse.result : rpcResponse;
    },
  };
}

test('dogfood: MCP tools/list returns 10 tools', () => {
  const server = createServer();
  const client = createDogfoodClient(server);
  const result = client.listTools();
  assert.ok(result, 'tools/list must return result');
  assert.ok(Array.isArray(result.tools), 'result.tools must be array');
  assert.equal(result.tools.length, 10, 'Must have 10 MCP tools');
  const names = result.tools.map(t => t.name).sort();
  assert.deepEqual(names, [
    'axiom.agent', 'axiom.approvals', 'axiom.ask', 'axiom.compare',
    'axiom.dream', 'axiom.learn', 'axiom.plan', 'axiom.policy',
    'axiom.reason', 'axiom.verify',
  ].sort());
});

test('dogfood: agent verifies claim through MCP gate (read = allow)', () => {
  const kernel = createKernelFromEnv();
  kernel.learn('Deniz tuzludur', TEST_FIXTURE_LEARN_BYPASS);
  const server = createServer(kernel);
  const client = createDogfoodClient(server);

  const result = client.callTool('axiom.verify', { statement: 'Deniz tuzludur' });
  assert.ok(result, 'verify must return result');
  assert.equal(result.ok, true, 'verify must return ok=true');
  assert.equal(result.type, 'verify', 'verify must return type=verify');
  assert.equal(result.data.status, 'dogrulandi', 'Known fact must return dogrulandi');
  assert.ok(result.data.confidence >= 0.5, 'Confidence must be >= 0.5');
});

test('dogfood: agent blocked from mutating tool through MCP gate (learn = review)', () => {
  const kernel = createKernelFromEnv();
  const server = createServer(kernel);
  const client = createDogfoodClient(server);

  // Before calling learn, check that the gate blocks it
  const uniqueFact = 'Xenon mor fenerdir';
  const result = client.callTool('axiom.learn', { text: uniqueFact });
  assert.ok(result, 'learn must return result');
  assert.ok(result.gate, 'blocked learn must return gate metadata');
  assert.equal(result.gate.allowed, false, 'learn must not be allowed by gate');
  assert.equal(result.gate.canExecute, false, 'learn must not be executable');
  assert.ok(result.gate.canDryRun, 'learn must support dry run');
  // Verify the unique fact was NOT learned (gate blocked it)
  const verifyResult = client.callTool('axiom.verify', { statement: uniqueFact });
  assert.equal(verifyResult.data.status, 'bilinmiyor', 'Fact must not be in graph (gate blocked learn)');
});

test('dogfood: agent receives dry-run result for review-blocked tool', () => {
  const kernel = createKernelFromEnv();
  const server = createServer(kernel);
  const client = createDogfoodClient(server);

  const result = client.callTool('axiom.learn', { text: 'Kedi hayvandir' });
  assert.ok(result, 'learn must return result');
  // If dry-run is implemented, result.dryRun should be true
  if (result.dryRun) {
    assert.ok(result.result, 'dry-run must include simulated result');
    assert.ok(result.gate.canDryRun, 'gate must report canDryRun');
  } else if (result.approval) {
    // If dry-run not implemented, approval queue should capture it
    assert.ok(result.approval.id, 'approval must have id');
    assert.equal(result.approval.status, 'pending', 'approval must be pending');

    // Check approvals list
    const approvals = client.callTool('axiom.approvals', {});
    assert.ok(approvals.pendingCount >= 1, 'approvals must show at least 1 pending');
    assert.ok(approvals.approvals.length >= 1, 'approvals list must not be empty');
  }
});

test('dogfood: unknown tool returns gate block', () => {
  const kernel = createKernelFromEnv();
  const server = createServer(kernel);
  const client = createDogfoodClient(server);

  const result = client.callTool('unknown.tool', { input: 'test' });
  assert.ok(result, 'unknown tool must return result');
  assert.ok(result.gate, 'must return gate metadata');
  assert.equal(result.gate.allowed, false, 'unknown tool must be blocked');
  assert.equal(result.gate.canExecute, false, 'unknown tool must not execute');
  assert.equal(result.gate.decision, 'block', 'unknown tool must be blocked');
});

test('dogfood: full agent loop through MCP produces receipt + gate trail', () => {
  const kernel = createKernelFromEnv();
  const server = createServer(kernel);
  const client = createDogfoodClient(server);

  // Step 1: Learn a base fact (blocked by gate, goes to review queue)
  const uniqueBase = 'Krill balina sever';
  const learnResult = client.callTool('axiom.learn', { text: uniqueBase });
  assert.ok(learnResult.gate, 'learn must go through gate');

  // Step 2: Verify a related claim (allowed)
  const verifyResult = client.callTool('axiom.verify', { statement: uniqueBase });
  // Since learn was blocked, verify should return bilinmiyor
  assert.ok(verifyResult.ok, 'verify must succeed');
  assert.equal(verifyResult.data.status, 'bilinmiyor',
    'verify must return bilinmiyor for unlearned fact');

  // Step 3: Check approvals for the blocked learn
  const approvalsResult = client.callTool('axiom.approvals', { limit: 10 });
  // At minimum, the structure must be correct
  assert.ok('pendingCount' in approvalsResult, 'approvals must have pendingCount');
  assert.ok(Array.isArray(approvalsResult.approvals), 'approvals must be array');
});
