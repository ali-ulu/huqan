'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callTool, createServer } = require('../mcpServer');

// ─── Mock kernel ────────────────────────────────────────────────────────────

function mockKernel() {
  return {
    learn() { return { ok: true, data: { learned: 1, skipped: 0, conflicts: [], alternatives: [] }, type: 'learn', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    ask() { return { ok: true, data: { answer: 'mock', subject: 'x', unknown: false, alternatives: 0 }, type: 'ask', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    verify() { return { ok: true, data: { status: 'dogrulandi', confidence: 1 }, type: 'verify', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    reason() { return { ok: true, data: { subject: 'x', answer: 'y', forward: [], backward: [], cycles: [] }, type: 'reason', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    compare() { return { ok: true, data: { a: 'x', b: 'y', answer: 'z', common: [], onlyA: [], onlyB: [], paths: [] }, type: 'compare', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    dream() { return { ok: true, data: { hypotheses: [], learned: [], cycle: 0 }, type: 'dream', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
  };
}

// ─── Gate blocks review tools (axiom.learn) ─────────────────────────────────

test('callTool: axiom.learn is gated for review, and says so truthfully (gate)', () => {
  // This mock kernel has no graph and therefore no approval store, so there is
  // nowhere to queue anything. The call used to be reported as "queued for
  // review" regardless -- a claim about durable state that nothing backed
  // (#772). The gate verdict is unchanged; only the claim is.
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.learn', arguments: { text: 'test fact' } }, { approvalStore: null });

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'review');
  assert.equal(result.gate.allowed, false);
  assert.equal(result.gate.canExecute, false);
  assert.equal(result.gate.canDryRun, true);
  assert.equal(result.gate.requiredReview, true);
  assert.equal(result.gate.reason, 'mutating_requires_review');
  assert.ok(result.approval, 'review tool must return approval object');
  assert.equal(result.approval.persisted, false);
  assert.equal(result.error.code, 'REVIEW_NOT_PERSISTED');
  assert.ok(!result.message.includes('queued for review'));
});

// ─── Gate restores concrete review for agent tools ──────────────────────────

test('callTool: axiom.agent restores review when a concrete gate requests it', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.agent', arguments: { goal: 'test' } }, { approvalStore: null });

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'review');
  assert.equal(result.gate.allowed, false);
  assert.equal(result.gate.canExecute, false);
  assert.equal(result.gate.canDryRun, true);
  assert.equal(result.gate.requiredReview, true);
  assert.equal(result.gate.reason, 'agent_loop_requires_review');
  assert.equal(result.approval.persisted, false);
  assert.equal(result.error.code, 'REVIEW_NOT_PERSISTED');
});

// ─── Gate allows read-only tools ─────────────────────────────────────────────

test('callTool: axiom.ask passes gate (allow)', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.ask', arguments: { question: 'test?' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.answer, 'mock');
});

test('callTool: axiom.verify passes gate (allow)', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.verify', arguments: { statement: 'test' } });

  assert.equal(result.ok, true);
  // Stub kernel says 'dogrulandi'; the MCP boundary emits canonical English.
  assert.equal(result.data.status, 'verified');
});

test('callTool: axiom.reason passes gate (allow)', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.reason', arguments: { subject: 'x' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.subject, 'x');
});

test('callTool: axiom.compare passes gate (allow)', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.compare', arguments: { left: 'x', right: 'y' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.a, 'x');
});

test('callTool: axiom.dream passes gate (allow)', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.dream', arguments: {} });

  assert.equal(result.ok, true);
  assert.equal(result.data.cycle, 0);
});

// ─── Gate blocks unknown tools ───────────────────────────────────────────────

test('callTool: unknown tool blocked by gate', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'unknown.tool', arguments: {} });

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.gate.allowed, false);
  assert.equal(result.gate.canExecute, false);
  assert.equal(result.gate.reason, 'unknown_tool_blocked');
});

// ─── Gate response shape ─────────────────────────────────────────────────────

test('callTool: gate response contains all required fields', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.agent', arguments: { goal: 'x' } });

  assert.ok(result.gate);
  assert.ok(typeof result.gate.decision === 'string');
  assert.ok(typeof result.gate.allowed === 'boolean');
  assert.ok(typeof result.gate.canExecute === 'boolean');
  assert.ok(typeof result.gate.canDryRun === 'boolean');
  assert.ok(typeof result.gate.requiredReview === 'boolean');
  assert.ok(typeof result.gate.reason === 'string');
  assert.ok(result.gate.metadata);
  assert.ok(typeof result.gate.metadata.policyVersion === 'string');
  assert.ok(typeof result.message === 'string');
});

// ─── Server integration: tools/call with gate ────────────────────────────────

test('createServer + handleRequest: axiom.learn returns gate block', () => {
  const server = createServer();
  const response = server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'axiom.learn', arguments: { text: 'test' } },
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.ok(response.result);
  assert.equal(response.result.isError, true);

  const parsed = JSON.parse(response.result.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.gate.decision, 'review');
});

test('createServer + handleRequest: axiom.ask passes through', () => {
  const server = createServer();
  const response = server.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'axiom.ask', arguments: { question: 'test?' } },
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 2);
  assert.ok(response.result);
  assert.equal(response.result.isError, false);
});

// ─── Gate blocks all mutating tools ──────────────────────────────────────────

test('callTool: all known tools pass through gate (allow)', () => {
  const kernel = mockKernel();
  const allowTools = ['axiom.ask', 'axiom.verify', 'axiom.plan', 'axiom.policy', 'axiom.reason', 'axiom.compare', 'axiom.dream'];

  for (const tool of allowTools) {
    const result = callTool(kernel, { name: tool, arguments: {} });
    assert.ok(!result.gate || result.gate.canExecute, `${tool} should pass gate (no gate block)`);
  }
});

test('callTool: axiom.approvals passes gate (allow, returns pendingCount)', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, {
    name: 'axiom.approvals',
    operatorToken: 'test-operator',
    arguments: {},
  }, { operatorToken: 'test-operator' });

  assert.equal(typeof result.pendingCount, 'number');
  assert.ok(Array.isArray(result.approvals));
});
