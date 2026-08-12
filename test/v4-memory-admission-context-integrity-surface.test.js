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
        data: { status: 'unknown', confidence: 0 },
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

function assertMemoryAdmissionShape(result) {
  assert.ok(result.memoryAdmission, 'result must expose memoryAdmission metadata');
  assert.equal(result.meta.memoryAdmission.status, result.memoryAdmission.status);
  assert.equal(typeof result.memoryAdmission.ok, 'boolean');
  assert.equal(typeof result.memoryAdmission.status, 'string');
  assert.equal(typeof result.memoryAdmission.verdict, 'string');
  assert.equal(typeof result.memoryAdmission.reason, 'string');
  assert.ok(result.memoryAdmission.provenance);
  assert.equal(typeof result.memoryAdmission.provenance.present, 'boolean');
  assert.ok(result.memoryAdmission.contextIntegrity);
  assert.equal(typeof result.memoryAdmission.contextIntegrity.workspaceScoped, 'boolean');
  assert.equal(typeof result.memoryAdmission.contextIntegrity.canonicalMutation, 'boolean');
  assert.equal(typeof result.memoryAdmission.contextIntegrity.mutationAllowed, 'boolean');
}

test('axiom.learn returns memory admission metadata with review status', () => {
  const result = callTool(mockKernel(), {
    name: 'axiom.learn',
    arguments: {
      text: 'memory write requires review',
      workspaceId: 'v4-pr5-workspace',
      provenance: {
        provenanceId: 'prov-v4-pr5-review',
        sourceType: 'mcp_client',
        sourceRef: 'dogfood-pr5',
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'review');
  assertMemoryAdmissionShape(result);
  assert.equal(result.memoryAdmission.status, 'review_required');
  assert.equal(result.memoryAdmission.verdict, 'review');
  assert.equal(result.memoryAdmission.workspaceId, 'v4-pr5-workspace');
  assert.equal(result.memoryAdmission.provenance.present, true);
  assert.equal(result.memoryAdmission.provenance.sourceType, 'mcp_client');
  assert.equal(result.memoryAdmission.provenance.sourceRef, 'dogfood-pr5');
});

test('axiom.learn review does not falsely claim canonical admission or receipt materialization', () => {
  const result = callTool(mockKernel(), {
    name: 'axiom.learn',
    arguments: { text: 'pending only' },
  });

  assertMemoryAdmissionShape(result);
  assert.equal(result.memoryAdmission.status, 'review_required');
  assert.equal(result.memoryAdmission.contextIntegrity.canonicalMutation, false);
  assert.equal(result.memoryAdmission.contextIntegrity.mutationAllowed, false);
  assert.equal(result.memoryAdmission.receiptId, null);
  assert.equal(result.memoryAdmission.memoryId, null);
});

test('axiom.ask and axiom.verify do not report memory mutation', () => {
  for (const params of [
    { name: 'axiom.ask', arguments: { question: 'what is known?', workspaceId: 'v4-pr5-read' } },
    { name: 'axiom.verify', arguments: { statement: 'claim', workspaceId: 'v4-pr5-read' } },
  ]) {
    const result = callTool(mockKernel(), params);
    assert.equal(result.ok, true);
    assertMemoryAdmissionShape(result);
    assert.equal(result.memoryAdmission.status, 'not_applicable');
    assert.equal(result.memoryAdmission.contextIntegrity.canonicalMutation, false);
    assert.equal(result.memoryAdmission.contextIntegrity.mutationAllowed, false);
  }
});

test('unknown tool remains blocked and does not mutate memory', () => {
  const result = callTool(mockKernel(), {
    name: 'unknown.tool',
    arguments: { workspaceId: 'v4-pr5-unknown' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'block');
  assertMemoryAdmissionShape(result);
  assert.equal(result.memoryAdmission.status, 'not_applicable');
  assert.equal(result.memoryAdmission.workspaceId, 'v4-pr5-unknown');
  assert.equal(result.memoryAdmission.contextIntegrity.canonicalMutation, false);
  assert.equal(result.memoryAdmission.contextIntegrity.mutationAllowed, false);
});

test('null and malformed params do not crash or mutate memory', () => {
  const nullResult = callTool(mockKernel(), null);
  assert.equal(nullResult.ok, false);
  assert.equal(nullResult.verdict, 'block');
  assertMemoryAdmissionShape(nullResult);
  assert.equal(nullResult.memoryAdmission.status, 'not_applicable');
  assert.equal(nullResult.memoryAdmission.contextIntegrity.canonicalMutation, false);

  const malformedResult = callTool(mockKernel(), {
    name: 'axiom.learn',
    arguments: 'not-json',
  });
  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.verdict, 'review');
  assertMemoryAdmissionShape(malformedResult);
  assert.equal(malformedResult.memoryAdmission.status, 'review_required');
  assert.equal(malformedResult.memoryAdmission.contextIntegrity.canonicalMutation, false);
});

test('explicit workspace is reflected without leaking another workspace admission', () => {
  const first = callTool(mockKernel(), {
    name: 'axiom.learn',
    arguments: { text: 'first workspace write', workspaceId: 'workspace-a' },
  });
  const second = callTool(mockKernel(), {
    name: 'axiom.learn',
    arguments: { text: 'second workspace write', workspaceId: 'workspace-b' },
  });

  assert.equal(first.memoryAdmission.workspaceId, 'workspace-a');
  assert.equal(second.memoryAdmission.workspaceId, 'workspace-b');
  assert.notEqual(first.memoryAdmission.workspaceId, second.memoryAdmission.workspaceId);
  assert.equal(first.memoryAdmission.contextIntegrity.canonicalMutation, false);
  assert.equal(second.memoryAdmission.contextIntegrity.canonicalMutation, false);
});

test('no fake receiptId is returned when no stored or materialized receipt exists', () => {
  const result = callTool(mockKernel(), {
    name: 'axiom.learn',
    arguments: {
      text: 'receipt must not be fabricated',
      provenanceId: 'prov-v4-pr5-no-fake-receipt',
    },
  });

  assert.equal(result.memoryAdmission.status, 'review_required');
  assert.equal(result.memoryAdmission.receiptId, null);
  assert.equal(result.toolVerdict.receiptId, null);
});
