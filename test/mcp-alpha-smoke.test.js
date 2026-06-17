'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callTool, createServer } = require('../mcpServer');
const { evaluateMcpGate, MCP_GATE_DECISIONS, MCP_GATE_ADAPTER_VERSION } = require('../lib/mcp-gate-adapter');

// ─── Mock kernel ────────────────────────────────────────────────────────────

function mockKernel() {
  return {
    learn() { return { ok: true, data: { learned: 1, skipped: 0, conflicts: [], alternatives: [] }, type: 'learn', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    ask() { return { ok: true, data: { answer: 'kedi hayvandir', subject: 'kedi', unknown: false, alternatives: 0 }, type: 'ask', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    verify() { return { ok: true, data: { status: 'dogrulandi', confidence: 0.95 }, type: 'verify', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    reason() { return { ok: true, data: { subject: 'kedi', answer: 'hayvan', forward: [], backward: [], cycles: [] }, type: 'reason', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    compare() { return { ok: true, data: { a: 'kedi', b: 'kopek', answer: 'hayvan', common: [], onlyA: [], onlyB: [], paths: [] }, type: 'compare', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    dream() { return { ok: true, data: { hypotheses: [], learned: [], cycle: 0 }, type: 'dream', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
  };
}

// ─── PR3 Smoke: Full MCP dispatch round-trip ────────────────────────────────

test('PR3 smoke: axiom.ask dispatches through gate + kernel', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.ask', arguments: { question: 'kedi nedir?' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.subject, 'kedi');
  assert.equal(typeof result.data.answer, 'string');
});

test('PR3 smoke: axiom.verify dispatches through gate + kernel', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.verify', arguments: { statement: 'kedi hayvandir' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'dogrulandi');
  assert.ok(result.data.confidence > 0);
});

test('PR3 smoke: axiom.learn blocked at gate (review)', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.learn', arguments: { text: 'kopek hayvandir' } });

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'review');
  assert.equal(result.gate.canExecute, false);
  assert.equal(result.gate.canDryRun, true);
});

test('PR3 smoke: axiom.agent returns dry-run (gate)', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'axiom.agent', arguments: { goal: 'kedi hakkinda bilgi topla' } });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.gate.decision, 'dry_run_only');
  assert.equal(result.gate.canExecute, false);
  assert.equal(result.gate.canDryRun, true);
});

test('PR3 smoke: unknown tool blocked at gate', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, { name: 'shell.exec', arguments: { command: 'rm -rf /' } });

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.gate.canExecute, false);
  assert.equal(result.gate.canDryRun, false);
});

// ─── PR3 Smoke: Server-level JSON-RPC round-trip ────────────────────────────

test('PR3 smoke: server initialize + tools/list', () => {
  const server = createServer();
  const initResp = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initResp.result.protocolVersion, '2025-06-18');
  assert.equal(initResp.result.serverInfo.name, 'axiom');

  const listResp = server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(Array.isArray(listResp.result.tools));
  assert.ok(listResp.result.tools.length >= 10);
});

test('PR3 smoke: server callTool via tools/call for axiom.ask', () => {
  const server = createServer();
  const resp = server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'axiom.ask', arguments: { question: 'kedi nedir?' } },
  });

  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 3);
  assert.equal(resp.result.isError, false);
  const parsed = JSON.parse(resp.result.content[0].text);
  assert.equal(parsed.ok, true);
});

test('PR3 smoke: server callTool via tools/call for axiom.learn (gate blocked)', () => {
  const server = createServer();
  const resp = server.handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'axiom.learn', arguments: { text: 'test' } },
  });

  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 4);
  assert.equal(resp.result.isError, true);
  const parsed = JSON.parse(resp.result.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.gate.decision, 'review');
});

// ─── PR3 Smoke: Adapter version check ───────────────────────────────────────

test('PR3 smoke: adapter version present in gate metadata', () => {
  const gate = evaluateMcpGate({ tool: 'axiom.learn', args: { text: 'test' } });
  assert.equal(gate.metadata.adapterVersion, MCP_GATE_ADAPTER_VERSION);
  assert.ok(MCP_GATE_ADAPTER_VERSION.startsWith('V2.6'));
});

// ─── PR3 Smoke: All 10 MCP tools have gate classifications ──────────────────

test('PR3 smoke: all 10 MCP tools classified', () => {
  const tools = ['axiom.ask', 'axiom.verify', 'axiom.plan', 'axiom.policy', 'axiom.approvals', 'axiom.reason', 'axiom.compare', 'axiom.dream', 'axiom.learn', 'axiom.agent'];
  for (const tool of tools) {
    const gate = evaluateMcpGate({ tool, args: {} });
    assert.ok(gate.decision, `${tool} should have a gate decision`);
    assert.ok(typeof gate.canExecute === 'boolean', `${tool} should have canExecute`);
  }
});
