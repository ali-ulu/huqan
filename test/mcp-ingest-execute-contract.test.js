'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { callTool, MODEL_VISIBLE_TOOL_SCHEMAS } = require('../mcpServer');
const { verifyIngestApprovalSnapshot } = require('../lib/ingest');
const { TOOL_SCHEMAS } = require('../lib/mcp-tool-catalog');
const { WORKFLOW_CAPABILITIES } = require('../lib/workflow-contract');

function ingestArgs(overrides = {}) {
  return {
    sourceType: 'manual',
    workspaceId: 'default',
    text: 'MCP ingest approval contract',
    title: 'MCP contract',
    ...overrides,
  };
}

function makeKernel() {
  const calls = [];
  return {
    calls,
    _ok: (op, data) => ({ ok: true, type: op, data, evidence: [], error: null, meta: {} }),
    _fail: (op, code, message) => ({ ok: false, type: op, data: null, evidence: [], error: { code, message }, meta: {} }),
    runCapability: async (capability, payload) => {
      calls.push({ capability, payload });
      return {
        ok: true,
        admission: {
          outcome: 'allow',
          graphWrite: true,
          entries: [{ workspaceId: 'default', receiptId: 'operation-receipt', auditId: 'operation-audit', graphWrite: true }],
        },
        evidence: [],
      };
    },
  };
}

function makeApprovalStore() {
  const records = new Map();
  return {
    records,
    saveToolApprovalIfAbsent(approval) {
      const existing = [...records.values()].find(item => item.approvalKey === approval.approvalKey);
      if (existing) return { inserted: false, approval: existing };
      records.set(approval.id, approval);
      return { inserted: true, approval };
    },
    getToolApprovalById(id) { return records.get(id) || null; },
    claimToolApproval() { return { claimed: false }; },
    rejectToolApproval() { return { rejected: false }; },
    claimToolApprovalWithLease(id) {
      const approval = records.get(id);
      if (!approval || approval.status !== 'pending') return { claimed: false, approval };
      approval.status = 'executing';
      approval.decision = 'approved';
      return { claimed: true, approval };
    },
    renewToolApprovalLease() { return { renewed: true }; },
    failToolApproval(id, reason) {
      const approval = records.get(id);
      if (approval) {
        approval.status = 'failed';
        approval.reason = reason;
      }
      return { failed: Boolean(approval), approval };
    },
    finalizeToolApprovalWithReceipt(id, options) {
      const approval = records.get(id);
      if (!approval || approval.status !== options.expectedStatus) return { finalized: false, approval };
      approval.status = options.decision;
      approval.decision = options.decision;
      approval.reason = options.reason;
      approval.context = { ...approval.context, receipt: options.receipt };
      return { finalized: true, approval };
    },
  };
}

function queue(kernel, approvalStore, args = ingestArgs()) {
  return callTool(kernel, {
    name: 'huqan.ingest_execute',
    arguments: JSON.stringify(args),
  }, { approvalStore });
}

async function approve(kernel, approvalStore, approvalId) {
  return callTool(kernel, {
    name: 'huqan.approve',
    arguments: JSON.stringify({ approvalId, decision: 'approved', workspaceId: 'default', reason: 'contract_test_approved' }),
    operatorToken: 'test-operator',
  }, { approvalStore, operatorToken: 'test-operator', recordIngestApprovalAudit: () => ({ auditId: 'final-audit' }) });
}

describe('huqan.ingest_execute (#787 P0)', () => {
  it('is published as a review-gated mutating MCP side of ingest-execute', () => {
    const tool = TOOL_SCHEMAS.find(entry => entry.name === 'huqan.ingest_execute');
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.deepEqual(tool.inputSchema.required, ['sourceType']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(MODEL_VISIBLE_TOOL_SCHEMAS.some(entry => entry.name === 'huqan.ingest_execute'));
    const workflow = WORKFLOW_CAPABILITIES.find(entry => entry.workflowId === 'ingest-execute');
    assert.equal(workflow.mcpTool, 'huqan.ingest_execute');
    assert.equal(workflow.availability.mcp, true);
    assert.equal(workflow.approvalRequired, true);
  });

  it('queues a durable http.ingest approval with a verifiable snapshot and status route', () => {
    const kernel = makeKernel();
    const approvalStore = makeApprovalStore();
    const result = queue(kernel, approvalStore);

    assert.equal(result.ok, false);
    assert.equal(result.gate.decision, 'review');
    assert.equal(result.approval.persisted, true);
    assert.equal(result.approval.tool, 'http.ingest');
    assert.equal(result.approval.context.mcpTool, 'huqan.ingest_execute');
    assert.equal(result.approval.context.queuedForExecution, true);
    assert.equal(result.data.approvalId, result.approval.id);
    // huqan.ingest_status takes `runId`, and its schema calls that the
    // identifier "returned by ingest execute" -- but this response used to
    // carry the value only as approvalId, so the advertised
    // preview -> execute -> status flow ended with no field by the name the
    // next call asks for. The HTTP surface has always emitted both.
    assert.equal(result.data.runId, result.approval.id);
    assert.equal(result.data.statusRoute, `/api/v2/ingest/runs/${result.approval.id}`);
    assert.equal(result.data.queuedForExecution, true);
    assert.deepEqual(verifyIngestApprovalSnapshot(result.approval.context.snapshot).ok, true);
    assert.equal(kernel.calls.length, 0, 'queueing must not execute the capability');
  });

  it('executes only after operator approval and returns bounded receipt plus audit reference', async () => {
    const kernel = makeKernel();
    const approvalStore = makeApprovalStore();
    const queued = queue(kernel, approvalStore);
    const result = await approve(kernel, approvalStore, queued.approval.id);

    assert.equal(result.ok, true);
    assert.equal(result.data.decision, 'approved');
    assert.equal(result.data.executed, true);
    assert.equal(result.data.approval.status, 'approved');
    assert.equal(result.data.receipt.actionExecution, 'ingest_capability_executed');
    assert.ok(result.data.receipt.receiptId);
    assert.equal(result.data.refs.auditRef, 'final-audit');
    assert.equal(kernel.calls.length, 1);
    assert.equal(kernel.calls[0].capability, 'companyBrain');
    assert.equal(approvalStore.getToolApprovalById(queued.approval.id).status, 'approved');
  });

  it('keeps approval decision idempotent after execution', async () => {
    const kernel = makeKernel();
    const approvalStore = makeApprovalStore();
    const queued = queue(kernel, approvalStore);
    const first = await approve(kernel, approvalStore, queued.approval.id);
    const second = await approve(kernel, approvalStore, queued.approval.id);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.data.idempotent, true);
    assert.equal(second.data.approval.status, 'approved');
    assert.equal(kernel.calls.length, 1, 'idempotent approval must not execute twice');
  });

  it('fails closed for external snapshot-required sources', () => {
    const kernel = makeKernel();
    const approvalStore = makeApprovalStore();
    const result = queue(kernel, approvalStore, ingestArgs({ sourceType: 'github', repoUrl: 'https://github.com/example/repo' }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'REVIEW_NOT_PERSISTED');
    assert.equal(result.approval.persisted, false);
    assert.equal(result.approval.notPersistedReason, 'INGEST_SNAPSHOT_REQUIRED');
    assert.equal(kernel.calls.length, 0);
  });
});
