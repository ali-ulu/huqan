'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createWorkflowDataRoutes } = require('../lib/http/workflow-data-routes');
const { WORKFLOW_CAPABILITIES } = require('../lib/workflow-contract');
const { buildIngestWorkflowRun } = require('../lib/ingest-workflow-run');

function fixture(records = [], overrides = {}) {
  const byId = new Map(records.map(record => [record.id, record]));
  const writes = [];
  const decisions = [];
  const handler = createWorkflowDataRoutes({
    getApprovalStore: () => ({
      listUnresolvedToolApprovals: (limit, workspaceId) => records
        .filter(record => record.context?.snapshot?.workspaceId === workspaceId)
        .slice(0, limit),
      getToolApprovalById: (id, workspaceId) => {
        const record = byId.get(id) || null;
        return record && record.context?.snapshot?.workspaceId === workspaceId ? record : null;
      },
    }),
    decideApproval: async input => {
      decisions.push(input);
      const record = byId.get(input.approvalId);
      record.status = input.decision;
      record.decision = input.decision;
      return { status: 200, json: { approval: record, idempotent: false } };
    },
    readReceipt: overrides.readReceipt || ((id, filters) => id === 'receipt-1'
      ? { ok: true, receipt: { receiptId: id, workspaceId: filters.workspaceId } }
      : { ok: false, status: 'not_found', error: { message: 'missing' } }),
    parseJsonRequest: async req => req.body,
    writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
    proposeLearn: overrides.proposeLearn || (async () => ({ approval: { id: 'approval-learn', persisted: true, context: {} } })),
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

  it('does not lose a tenant\'s own approvals behind another tenant\'s pending queue (#1287)', async () => {
    // 60 other-workspace approvals sorted ahead of 3 belonging to the
    // requesting tenant -- with the pre-fix "fetch default limit, then
    // filter" ordering, the default-limit page (50) would be entirely
    // other-tenant records and this tenant's own queue would appear empty.
    const noisyTenant = Array.from({ length: 60 }, (_, i) => approval(`noisy-${i}`, 'beta'));
    const ownApprovals = [approval('a', 'alpha'), approval('b', 'alpha'), approval('c', 'alpha')];
    const { invoke } = fixture([...noisyTenant, ...ownApprovals]);

    const result = await invoke('GET', '/api/v2/approvals?workspaceId=alpha');
    assert.equal(result.write.status, 200);
    assert.deepEqual(result.write.json.data.approvals.map(item => item.id).sort(), ['a', 'b', 'c']);
    assert.equal(result.write.json.data.total, 3);
    assert.equal(result.write.json.data.windowTruncated, false);
  });

  it('never returns a raw driver/exception message for a failed receipt read (#1283)', async () => {
    const leakyMessage = 'SQLITE_CORRUPT: database disk image is malformed (/var/lib/huqan/tenant-a/memory.db, journal offset 40961)';
    const { invoke: invokeLeaky } = fixture([], {
      readReceipt: () => ({ ok: false, status: 'read_error', error: { message: leakyMessage } }),
    });
    const leaky = await invokeLeaky('GET', '/api/v2/trust-receipts/leaky?workspaceId=alpha');
    assert.equal(leaky.write.json.error.message.includes('SQLITE_CORRUPT'), false);
    assert.equal(leaky.write.json.error.message.includes('/var/lib/huqan'), false);
    assert.equal(leaky.write.json.error.message, 'receiptId is not valid');

    const throwMessage = 'driver exploded: /var/lib/huqan/tenant-a/memory.db';
    const { invoke: invokeThrows } = fixture([], {
      readReceipt: () => { throw new Error(throwMessage); },
    });
    const thrown = await invokeThrows('GET', '/api/v2/trust-receipts/throws?workspaceId=alpha');
    assert.equal(thrown.write.json.error.message.includes('/var/lib/huqan'), false);
    assert.equal(thrown.write.json.error.message, 'receiptId is not valid');
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
    assert.deepEqual(result.decisions, [{ approvalId: 'a', workspaceId: 'alpha', decision: 'approved', reason: '' }]);
  });

  it('enforces the published approval-decision body schema before dispatch', async () => {
    const { invoke } = fixture([approval('a', 'alpha')]);
    const result = await invoke('POST', '/api/v2/approvals/a/decision?workspaceId=alpha', {
      decision: 'approved', unexpected: true,
    });
    assert.equal(result.write.status, 400);
    assert.equal(result.write.json.error.code, 'INVALID_INPUT');
    assert.deepEqual(result.decisions, []);
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
    assert.deepEqual(capabilities.get('ingest-run-detail').availability, { api: true, cli: true, mcp: true, ui: true });
  });
});
