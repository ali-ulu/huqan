'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callTool } = require('../mcpServer');

function mockKernel() {
  return {
    learn() {
      return {
        ok: true,
        type: 'learn',
        data: { learned: 1, skipped: 0, conflicts: [], alternatives: [] },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0', backend: 'memory', paranoidMode: false },
      };
    },
    ask() {
      return {
        ok: true,
        type: 'ask',
        data: { answer: 'mock answer', subject: 'x', unknown: false, alternatives: 0 },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0', backend: 'memory', paranoidMode: false },
      };
    },
    verify() {
      return {
        ok: true,
        type: 'verify',
        data: { status: 'dogrulandi', confidence: 1 },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0', backend: 'memory', paranoidMode: false },
      };
    },
    reason() {
      return { ok: true, type: 'reason', data: {}, evidence: [], error: null, meta: {} };
    },
    compare() {
      return { ok: true, type: 'compare', data: {}, evidence: [], error: null, meta: {} };
    },
    dream() {
      return { ok: true, type: 'dream', data: { hypotheses: [], learned: [], cycle: 0 }, evidence: [], error: null, meta: {} };
    },
  };
}

function assertToolVerdict(result, expected) {
  assert.ok(result.toolVerdict, 'result must expose toolVerdict metadata');
  assert.equal(result.verdict, expected.verdict);
  assert.equal(result.toolVerdict.verdict, expected.verdict);
  assert.equal(result.toolVerdict.tool, expected.tool);
  assert.equal(result.toolVerdict.ok, expected.ok);
  assert.equal(typeof result.toolVerdict.reason, 'string');
  assert.ok(result.toolVerdict.reason.length > 0);
  assert.equal(result.meta.toolVerdict.verdict, expected.verdict);
  assert.equal(result.meta.toolVerdict.tool, expected.tool);
}

test('legacy axiom.ask exposes allow verdict metadata', () => {
  const result = callTool(mockKernel(), {
    name: 'axiom.ask',
    arguments: { question: 'test?', workspaceId: 'dogfood-workspace' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.answer, 'mock answer');
  assertToolVerdict(result, { verdict: 'allow', tool: 'huqan.ask', ok: true });
  assert.equal(result.toolVerdict.workspaceId, 'dogfood-workspace');

  // The call used the legacy spelling, so the verdict surface reports the
  // canonical name it was gated under, and `meta.deprecation` records which
  // name the caller actually sent. Both halves matter: the first makes the
  // verdict unambiguous, the second is how a client learns to migrate.
  assert.equal(result.meta.deprecation.requestedName, 'axiom.ask');
  assert.equal(result.meta.deprecation.canonicalName, 'huqan.ask');
});

test('legacy axiom.verify exposes allow verdict metadata', () => {
  const result = callTool(mockKernel(), {
    name: 'axiom.verify',
    arguments: { statement: 'test statement' },
  });

  assert.equal(result.ok, true);
  // The stub kernel above answers 'dogrulandi'; MCP emits the canonical
  // spelling, so this asserts the boundary adapter, not the kernel.
  assert.equal(result.data.status, 'verified');
  assertToolVerdict(result, { verdict: 'allow', tool: 'huqan.verify', ok: true });
});

test('legacy axiom.learn exposes review verdict metadata without synthetic receipt', () => {
  const result = callTool(mockKernel(), {
    name: 'axiom.learn',
    arguments: { text: 'fact for review' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'review');
  assert.ok(result.approval, 'review path must still create an approval request');
  assertToolVerdict(result, { verdict: 'review', tool: 'huqan.learn', ok: false });
  assert.equal(result.toolVerdict.receiptId, null);
});

test('legacy axiom.agent exposes restored review verdict metadata', () => {
  const result = callTool(mockKernel(), {
    name: 'axiom.agent',
    arguments: { goal: 'inspect only' },
  }, { approvalStore: null });

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'review');
  assert.equal(result.gate.reason, 'agent_loop_requires_review');
  assert.equal(result.approval.persisted, false);
  assert.equal(result.error.code, 'REVIEW_NOT_PERSISTED');
  assertToolVerdict(result, { verdict: 'review', tool: 'huqan.agent', ok: false });
});

test('unknown tool fails closed with block verdict metadata', () => {
  const result = callTool(mockKernel(), {
    name: 'unknown.tool',
    arguments: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.gate.reason, 'unknown_tool_blocked');
  assertToolVerdict(result, { verdict: 'block', tool: 'unknown.tool', ok: false });
  assert.equal(result.toolVerdict.receiptId, null);
});

test('null params do not crash and fail closed with verdict metadata', () => {
  const result = callTool(mockKernel(), null);

  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.gate.reason, 'malformed_input_blocked');
  assertToolVerdict(result, { verdict: 'block', tool: 'unknown', ok: false });
});

test('malformed arguments do not crash and still expose verdict metadata', () => {
  const result = callTool(mockKernel(), {
    name: 'axiom.ask',
    arguments: 'not-json',
  });

  assert.equal(result.ok, true);
  assertToolVerdict(result, { verdict: 'allow', tool: 'huqan.ask', ok: true });
});
