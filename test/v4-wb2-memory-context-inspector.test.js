'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { callTool } = require('../mcpServer');
const { inspectMemoryContext } = require('../lib/workbench/memory-context-inspector');

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
        data: { status: 'bilinmiyor', confidence: 0 },
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

function mcpLearnResult(workspaceId = 'wb2-workspace') {
  return callTool(mockKernel(), {
    name: 'axiom.learn',
    arguments: {
      text: 'memory context inspector proof',
      workspaceId,
      provenance: {
        provenanceId: 'prov-v4-wb2',
        sourceType: 'test',
        sourceRef: 'test:v4-wb2-inspector',
      },
    },
  });
}

function sourceFor(record) {
  return {
    readMemoryContext(query) {
      if (query.recordId !== record.recordId) return null;
      return record;
    },
  };
}

describe('V4-WB2: read-only Memory Admission / Context Integrity Inspector helper', () => {
  it('reads valid memory admission evidence from the PR5 MCP surface', () => {
    const result = mcpLearnResult('wb2-valid-memory');
    const record = { ...result, recordId: 'record-memory' };

    const inspected = inspectMemoryContext({
      recordId: 'record-memory',
      source: sourceFor(record),
    });

    assert.equal(inspected.ok, true);
    assert.equal(inspected.status, 'ok');
    assert.equal(inspected.memoryAdmission.status, 'review_required');
    assert.equal(inspected.memoryAdmission.decision, 'review');
    assert.equal(inspected.memoryAdmission.reason, 'mutating_requires_review');
    assert.equal(inspected.provenance.workspaceId, 'wb2-valid-memory');
    assert.equal(inspected.source.readOnly, true);
  });

  it('reads context integrity signals without creating a verdict', () => {
    const result = mcpLearnResult('wb2-context');
    const record = { ...result, recordId: 'record-context' };

    const inspected = inspectMemoryContext({
      recordId: 'record-context',
      source: sourceFor(record),
    });

    assert.equal(inspected.ok, true);
    assert.equal(inspected.contextIntegrity.status, 'present');
    assert.deepEqual(inspected.contextIntegrity.flags, ['workspace_scoped']);
    assert.equal(inspected.memoryAdmission.decision, 'review');
    assert.equal(inspected.source.readOnly, true);
  });

  it('missing input returns invalid_request', () => {
    const inspected = inspectMemoryContext();

    assert.equal(inspected.ok, false);
    assert.equal(inspected.status, 'invalid_request');
    assert.deepEqual(inspected.missingFields, ['input']);
    assert.equal(inspected.source.readOnly, true);
  });

  it('unknown record returns not_found without fake memory or context data', () => {
    const inspected = inspectMemoryContext({
      recordId: 'missing-record',
      source: { readMemoryContext: () => null },
    });

    assert.equal(inspected.ok, false);
    assert.equal(inspected.status, 'not_found');
    assert.equal(inspected.memoryAdmission.status, null);
    assert.equal(inspected.contextIntegrity.flags, null);
    assert.equal(inspected.provenance.receiptId, null);
    assert.equal(inspected.source.readOnly, true);
  });

  it('throwing read source returns structured read_error without throwing', () => {
    const inspected = inspectMemoryContext({
      recordId: 'record-read-error',
      source: {
        readMemoryContext() {
          throw new Error('boom');
        },
      },
    });

    assert.equal(inspected.ok, false);
    assert.equal(inspected.status, 'read_error');
    assert.equal(inspected.memoryAdmission.decision, null);
    assert.equal(inspected.contextIntegrity.status, null);
    assert.equal(inspected.source.readOnly, true);
  });

  it('does not mutate the input record or source data', () => {
    const result = mcpLearnResult('wb2-readonly');
    const record = { ...result, recordId: 'record-readonly' };
    const before = JSON.stringify(record);

    const inspected = inspectMemoryContext({
      recordId: 'record-readonly',
      source: sourceFor(record),
    });

    assert.equal(inspected.ok, true);
    assert.equal(JSON.stringify(record), before);
  });

  it('source.readOnly is always true for every terminal status', () => {
    const cases = [
      inspectMemoryContext(),
      inspectMemoryContext({ recordId: 'x' }),
      inspectMemoryContext({ recordId: 'x', source: { readMemoryContext: () => null } }),
      inspectMemoryContext({
        recordId: 'x',
        source: {
          readMemoryContext() {
            throw new Error('boom');
          },
        },
      }),
    ];

    for (const result of cases) {
      assert.equal(result.source.readOnly, true);
    }
  });
});
