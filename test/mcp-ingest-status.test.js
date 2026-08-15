'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { callTool, MODEL_VISIBLE_TOOL_SCHEMAS } = require('../mcpServer');
const { TOOL_SCHEMAS } = require('../lib/mcp-tool-catalog');
const { WORKFLOW_CAPABILITIES } = require('../lib/workflow-contract');
const { buildIngestWorkflowRun } = require('../lib/ingest-workflow-run');

function approvalRecord(overrides = {}) {
  return {
    id: 'run-1',
    approval_key: 'http.ingest.manual.key.sha256:abc',
    tool: 'http.ingest',
    status: 'pending',
    decision: 'review',
    reason: 'http_ingest_requires_review',
    context: {
      source: 'http-ingest',
      snapshot: {
        workspaceId: 'default',
        sourceType: 'manual',
        sourceRef: 'note',
        snapshotHash: `sha256:${'a'.repeat(64)}`,
        idempotencyKey: 'key-1',
      },
    },
    ...overrides,
  };
}

function kernelStub() {
  return {
    _ok: (op, data) => ({ ok: true, type: op, data, evidence: [], error: null, meta: {} }),
    _fail: (op, code, message) => ({ ok: false, type: op, data: null, evidence: [], error: { code, message }, meta: {} }),
    graph: { appendAuditEvent: () => {} },
  };
}

function call(args, { record = approvalRecord(), storeBroken = false } = {}) {
  const approvalStore = storeBroken ? {} : {
    getToolApprovalById: id => (record && id === record.id ? record : null),
  };
  return callTool(kernelStub(), {
    name: 'huqan.ingest_status',
    arguments: JSON.stringify(args),
  }, { approvalStore });
}

describe('huqan.ingest_status (#787)', () => {
  it('projects a pending run with progress, retry and resume contracts', () => {
    const result = call({ runId: 'run-1', workspaceId: 'default' });
    assert.equal(result.ok, true);
    assert.equal(result.data.workflowId, 'ingest-run-detail');
    assert.equal(result.data.runId, 'run-1');
    assert.equal(result.data.status, 'review_required');
    assert.equal(result.data.phase, 'awaiting_review');
    assert.deepEqual(result.data.progress, { completed: 0, total: 1, hasMore: false });
    // "not retryable, and here is why" is actionable; a missing field is not.
    assert.equal(result.data.retry.allowed, false);
    assert.ok(result.data.retry.reason.length > 0);
    assert.equal(result.data.resume.allowed, false);
    assert.ok(result.data.resume.reason.length > 0);
    assert.equal(result.data.nextAction, 'review');
    assert.equal(result.data.workspaceId, 'default');
  });

  it('reports the final receipt once the run is finalized', () => {
    const record = approvalRecord({
      status: 'approved',
      context: {
        source: 'http-ingest',
        receipt: { receiptId: 'receipt-9' },
        snapshot: {
          workspaceId: 'default', sourceType: 'manual', sourceRef: 'note',
          snapshotHash: `sha256:${'a'.repeat(64)}`, idempotencyKey: 'key-1',
        },
      },
    });
    const result = call({ runId: 'run-1', workspaceId: 'default' }, { record });
    assert.equal(result.data.status, 'completed');
    assert.equal(result.data.receiptId, 'receipt-9');
    assert.equal(result.data.nextAction, 'read_receipt');
  });

  it('matches the HTTP run projection field for field', () => {
    const record = approvalRecord();
    const http = buildIngestWorkflowRun(record);
    const mcp = call({ runId: 'run-1', workspaceId: 'default' }, { record });
    // Cross-surface parity is the point of the issue: the same run must not
    // read differently depending on which surface asked.
    for (const key of Object.keys(http)) {
      assert.deepEqual(mcp.data[key], http[key], key);
    }
  });

  it('hides runs owned by another workspace behind not-found', () => {
    const result = call({ runId: 'run-1', workspaceId: 'tenant-x' });
    assert.equal(result.ok, false);
    // Not a permission error: a distinct code would confirm the id exists.
    assert.equal(result.error.code, 'INGEST_RUN_NOT_FOUND');
  });

  it('does not project approvals belonging to other tools', () => {
    const result = call({ runId: 'run-1', workspaceId: 'default' }, {
      record: approvalRecord({ tool: 'mcp.huqan.learn' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INGEST_RUN_NOT_FOUND');
  });

  it('requires both runId and workspaceId', () => {
    assert.equal(call({ workspaceId: 'default' }).error.code, 'INVALID_INPUT');
    assert.equal(call({ runId: 'run-1' }).error.code, 'INVALID_INPUT');
  });

  it('fails closed when the approval store is unusable', () => {
    const result = call({ runId: 'run-1', workspaceId: 'default' }, { storeBroken: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'APPROVAL_STORE_UNAVAILABLE');
  });

  it('reports an unknown run state instead of guessing', () => {
    const result = call({ runId: 'run-1', workspaceId: 'default' }, {
      record: approvalRecord({ status: 'weird-state' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INGEST_RUN_STATE_UNKNOWN');
  });
});

describe('ingest_status tool surface and contract (#787)', () => {
  const tool = TOOL_SCHEMAS.find(entry => entry.name === 'huqan.ingest_status');

  it('is published as a read-only tool', () => {
    assert.ok(tool, 'tool must be in the catalog');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.deepEqual(tool.inputSchema.required, ['runId', 'workspaceId']);
    assert.equal(tool.inputSchema.additionalProperties, false);
  });

  it('is visible to the model, unlike the approval tools', () => {
    const names = MODEL_VISIBLE_TOOL_SCHEMAS.map(entry => entry.name);
    assert.ok(names.includes('huqan.ingest_status'));
    // Reading a run is safe to expose; deciding one is not (#797).
    assert.equal(names.includes('huqan.approve'), false);
    assert.equal(names.includes('huqan.approvals'), false);
  });

  it('is declared as the MCP side of the ingest-run-detail workflow', () => {
    const entry = WORKFLOW_CAPABILITIES.find(item => item.workflowId === 'ingest-run-detail');
    assert.equal(entry.mcpTool, 'huqan.ingest_status');
    assert.equal(entry.availability.mcp, true);
    assert.equal(entry.availability.api, true);
    assert.equal(entry.mutation, false);
  });
});
