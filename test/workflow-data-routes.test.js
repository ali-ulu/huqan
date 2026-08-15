'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createWorkflowDataRoutes } = require('../lib/http/workflow-data-routes');
const { WORKFLOW_CAPABILITIES } = require('../lib/workflow-contract');
const { buildIngestWorkflowRun } = require('../lib/ingest-workflow-run');

function fixture(records = []) {
  const byId = new Map(records.map(record => [record.id, record]));
  const writes = [];
  const decisions = [];
  const handler = createWorkflowDataRoutes({
    getApprovalStore: () => ({
      listUnresolvedToolApprovals: limit => records.slice(0, limit),
      getToolApprovalById: id => byId.get(id) || null,
    }),
    decideApproval: async input => {
      decisions.push(input);
      const record = byId.get(input.approvalId);
      record.status = input.decision;
      record.decision = input.decision;
      return { status: 200, json: { approval: record, idempotent: false } };
    },
    readReceipt: (id, filters) => id === 'receipt-1'
      ? { ok: true, receipt: { receiptId: id, workspaceId: filters.workspaceId } }
      : { ok: false, status: 'not_found', error: { message: 'missing' } },
    parseJsonRequest: async req => req.body,
    writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
    learnDocument: () => ({}),
    submitIngest: async () => ({}),
    createAgent: () => ({ plan: () => ({ ok: true, data: {} }), run: () => ({ ok: true, data: {} }) }),
  });
  const invoke = async (method, path, body) => {
    const req = { method, body };
    const handled = await handler(req, {}, new URL(path, 'http://localhost'));
    return { handled, write: writes.at(-1), decisions };
  };
  return { invoke };
}

const approval = (id, workspaceId) => ({
  id,
  approval_key: `key-${id}`,
  tool: 'http.ingest',
  status: 'pending',
  decision: 'review',
  context: { snapshot: {
    workspaceId,
    sourceType: 'manual',
    sourceRef: `manual:${id}`,
    snapshotHash: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: `ingest-${id}`,
  } },
});

describe('canonical workflow data routes', () => {
  it('lists only approvals in the exact workspace using the common envelope', async () => {
    const foreignTool = { ...approval('c', 'alpha'), tool: 'external.fetch' };
    const { invoke } = fixture([approval('a', 'alpha'), approval('b', 'beta'), foreignTool]);
    const result = await invoke('GET', '/api/v2/approvals?workspaceId=alpha');
    assert.equal(result.handled, true);
    assert.equal(result.write.status, 200);
    assert.equal(result.write.json.workflowId, 'approvals');
    assert.equal(result.write.json.status, 'completed');
    assert.deepEqual(result.write.json.data.approvals.map(item => item.id), ['a']);
    assert.equal(result.write.headers['Cache-Control'], 'no-store');
  });

  it('does not disclose an approval from another workspace', async () => {
    const { invoke } = fixture([approval('a', 'alpha')]);
    const result = await invoke('GET', '/api/v2/approvals/a?workspaceId=beta');
    assert.equal(result.write.status, 404);
    assert.equal(result.write.json.error.code, 'APPROVAL_NOT_FOUND');
  });

  it('reuses the existing approval decision seam', async () => {
    const { invoke } = fixture([approval('a', 'alpha')]);
    const result = await invoke('POST', '/api/v2/approvals/a/decision?workspaceId=alpha', { decision: 'approved' });
    assert.equal(result.write.status, 200);
    assert.equal(result.write.json.workflowId, 'approval-decision');
    assert.equal(result.write.json.data.approval.status, 'approved');
    assert.deepEqual(result.decisions, [{ approvalId: 'a', decision: 'approved', reason: '' }]);
  });

  it('reads a workspace-scoped receipt through the canonical alias', async () => {
    const { invoke } = fixture();
    const result = await invoke('GET', '/api/v2/trust-receipts/receipt-1?workspaceId=alpha');
    assert.equal(result.write.status, 200);
    assert.equal(result.write.json.workflowId, 'trust-receipt-detail');
    assert.equal(result.write.json.receiptId, 'receipt-1');
    assert.equal(result.write.json.data.receipt.workspaceId, 'alpha');
  });

  it('projects bounded progress and truthful resume semantics from the canonical ingest approval', async () => {
    const pending = approval('run-1', 'alpha');
    const { invoke } = fixture([pending]);
    const result = await invoke('GET', '/api/v2/ingest/runs/run-1?workspaceId=alpha');
    assert.equal(result.write.status, 200);
    assert.equal(result.write.json.status, 'review_required');
    assert.deepEqual(result.write.json.data.progress, { completed: 0, total: 1, hasMore: false });
    assert.deepEqual(result.write.json.data.resume, {
      allowed: false,
      reason: 'ingest_runs_have_no_paused_checkpoint',
    });
    assert.equal(result.write.json.data.nextAction, 'review');
    assert.equal(result.write.json.data.retry.allowed, false);
  });

  it('does not disclose an ingest run from another workspace', async () => {
    const { invoke } = fixture([approval('run-1', 'alpha')]);
    const result = await invoke('GET', '/api/v2/ingest/runs/run-1?workspaceId=beta');
    assert.equal(result.write.status, 404);
    assert.equal(result.write.json.error.code, 'INGEST_RUN_NOT_FOUND');
  });

  it('marks unknown failures as manual reconciliation instead of retryable', () => {
    const failed = { ...approval('run-1', 'alpha'), status: 'failed', reason: 'execution_outcome_unknown' };
    const run = buildIngestWorkflowRun(failed);
    assert.equal(run.status, 'failed');
    assert.equal(run.phase, 'reconciliation_required');
    assert.equal(run.retry.allowed, false);
    assert.equal(run.resume.allowed, false);
  });

  it('fails closed when an exact workspace is missing', async () => {
    const { invoke } = fixture();
    const result = await invoke('GET', '/api/v2/approvals');
    assert.equal(result.write.status, 400);
    assert.equal(result.write.json.error.code, 'MISSING_WORKSPACE_ID');
  });

  it('rejects the wrong method before consuming workspace input', async () => {
    const { invoke } = fixture();
    const result = await invoke('POST', '/api/v2/approvals');
    assert.equal(result.write.status, 405);
    assert.equal(result.write.json.error.code, 'METHOD_NOT_ALLOWED');
  });

  it('publishes only routes that are actually served', () => {
    const capabilities = new Map(WORKFLOW_CAPABILITIES.map(item => [item.workflowId, item]));
    assert.equal(capabilities.get('approvals').availability.api, true);
    assert.equal(capabilities.get('approval-detail').availability.api, true);
    assert.equal(capabilities.get('approval-decision').availability.api, true);
    assert.equal(capabilities.get('trust-receipt-detail').route, '/api/v2/trust-receipts/{id}');
    assert.deepEqual(capabilities.get('ingest-run-detail').availability, { api: true, cli: true, mcp: true, ui: false });
  });
});
