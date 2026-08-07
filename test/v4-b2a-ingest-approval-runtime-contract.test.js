'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const AxiomStorage = require('../storage');
const { ACTION_OUTCOMES } = require('../lib/workbench/ingest-approval-action');

const VERDICT = 'V4_B2_EXISTING_RUNTIME_CONTRACT_BLOCKED_GAP';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-b2a-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'v4-b2a-test-key';
process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'graph.json');
process.env.AXIOM_DB_PATH = path.join(tempDir, 'graph.db');
delete process.env.AXIOM_USE_SQLITE;

const CLI = require('../cli');
const cliModulePath = require.resolve('../cli');
const originalCliExport = require.cache[cliModulePath].exports;
let serverCli = null;
let server = null;
let store = null;
let port = 0;

class ContractTestCLI extends CLI {
  constructor(...args) {
    super(...args);
    serverCli = this;
  }
}

try {
  require.cache[cliModulePath].exports = ContractTestCLI;
  server = require('../server');
} finally {
  require.cache[cliModulePath].exports = originalCliExport;
}

function requestJson(pathname, options = {}) {
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: {
        ...(options.auth === false ? {} : { Authorization: `Bearer ${process.env.AXIOM_API_KEY}` }),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (error) { reject(error); return; }
        resolve({ status: response.statusCode, body: parsed, headers: response.headers });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

// V4-B2B superseded the original caller-selected workspace input: this surface
// now binds canonical `default` and fails a non-default value closed before
// persistence. The durable lifecycle coverage below is unchanged.
function payload(suffix, overrides = {}) {
  return {
    sourceType: 'manual',
    author: 'v4-b2a-contract',
    date: '2026-08-05',
    text: `v4 b2a ${suffix} hayvandir`,
    idempotencyKey: `v4-b2a-${suffix}`,
    ...overrides,
  };
}

async function queue(suffix, overrides = {}) {
  const response = await requestJson('/api/ingest', {
    method: 'POST',
    body: payload(suffix, overrides),
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'pending');
  return response.body;
}

function graphSnapshot() {
  const graph = serverCli.kernel.graph;
  const stats = graph.getStats();
  return {
    nodes: stats.nodes,
    edges: stats.edges,
    audit: graph.getAuditEvents({}).map((event) => ({
      auditId: event.auditId,
      eventType: event.eventType,
      targetType: event.targetType,
      targetId: event.targetId,
    })),
  };
}

function approvalAudit(approvalId, eventType) {
  return serverCli.kernel.graph.getAuditEvents({ targetType: 'ingest_approval', targetId: approvalId })
    .find((event) => event.eventType === eventType) || null;
}

before(async () => {
  assert.equal(serverCli.kernel.graph.getStats().backend, 'sqlite');
  store = new AxiomStorage({ kernel: serverCli.kernel });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  server.closeAxiom();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('V4-B2A: existing durable ingest approval runtime contract', () => {
  it('requires authentication, queues once and performs no Graph mutation before review', async () => {
    const before = graphSnapshot();
    const denied = await requestJson('/api/ingest', {
      method: 'POST', auth: false, body: payload('queue'),
    });
    assert.equal(denied.status, 401);
    assert.equal(store.countPendingToolApprovals(), 0);
    assert.deepEqual(graphSnapshot(), before);

    const first = await queue('queue');
    const record = store.getToolApprovalById(first.approval.id);
    assert.equal(record.tool, 'http.ingest');
    assert.equal(record.status, 'pending');
    assert.equal(record.decision, 'review');
    assert.equal(record.context.snapshot.snapshotHash, first.approval.snapshotHash);
    assert.equal(record.context.snapshot.idempotencyKey, 'v4-b2a-queue');
    assert.equal(record.context.snapshot.workspaceId, 'default');
    assert.deepEqual(graphSnapshot(), before);

    const replay = await requestJson('/api/ingest', {
      method: 'POST', body: payload('queue'),
    });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.approval.id, first.approval.id);
    assert.equal(store.countPendingToolApprovals(), 1);

    const deniedList = await requestJson('/api/ingest/approvals', { auth: false });
    assert.equal(deniedList.status, 401);
    const listed = await requestJson('/api/ingest/approvals');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.approvals.some((item) => item.id === first.approval.id));
  });

  it('rejects one exact pending record with receipt and audit but no node/edge mutation', async () => {
    const queued = await queue('reject');
    const before = graphSnapshot();
    const rejected = await requestJson(`/api/ingest/approvals/${queued.approval.id}`, {
      method: 'POST',
      body: { decision: 'rejected', workspaceId: 'decision-controlled-workspace' },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.approval.status, 'rejected');
    assert.equal(rejected.body.receipt.receiptKind, 'blocked_action_receipt');
    assert.equal(rejected.body.receipt.actionExecution, 'not_executed');
    assert.equal(rejected.body.receipt.workspaceId, 'default');
    assert.equal(rejected.body.receipt.metadata.snapshotHash, queued.approval.snapshotHash);
    assert.ok(rejected.body.auditRef);

    const durable = store.getToolApprovalById(queued.approval.id);
    assert.equal(durable.status, 'rejected');
    assert.deepEqual(durable.context.receipt, rejected.body.receipt);
    const after = graphSnapshot();
    assert.equal(after.nodes, before.nodes);
    assert.equal(after.edges, before.edges);
    assert.ok(approvalAudit(queued.approval.id, 'APPROVAL_REJECTED'));

    const cannotApprove = await requestJson(`/api/ingest/approvals/${queued.approval.id}`, {
      method: 'POST', body: { decision: 'approved' },
    });
    assert.equal(cannotApprove.status, 200);
    assert.equal(cannotApprove.body.idempotent, true);
    assert.equal(cannotApprove.body.approval.status, 'rejected');
  });

  it('fails closed for unknown identity and enforces one durable execution claim', async () => {
    const before = graphSnapshot();
    const unknown = await requestJson('/api/ingest/approvals/missing-approval', {
      method: 'POST', body: { decision: 'approved' },
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(graphSnapshot(), before);

    const queued = await queue('claim');
    const first = store.claimToolApprovalWithLease(queued.approval.id, {
      owner: 'v4-b2a-claim-owner', leaseMs: 60_000,
    });
    const second = store.claimToolApprovalWithLease(queued.approval.id, {
      owner: 'v4-b2a-other-owner', leaseMs: 60_000,
    });
    assert.equal(first.claimed, true);
    assert.equal(first.approval.status, 'executing');
    assert.equal(second.claimed, false);
    assert.equal(second.approval.context.executionClaim.owner, 'v4-b2a-claim-owner');

    const routeRetry = await requestJson(`/api/ingest/approvals/${queued.approval.id}`, {
      method: 'POST', body: { decision: 'approved' },
    });
    assert.equal(routeRetry.status, 409);
    assert.equal(routeRetry.body.error.code, 'APPROVAL_EXECUTION_IN_PROGRESS');
  });

  it('recovers an expired lease to unknown outcome and never retries it automatically', async () => {
    const id = 'approval-v4-b2a-expired';
    store.saveToolApproval({
      id,
      approvalKey: 'v4-b2a-expired-key',
      tool: 'http.ingest',
      input: '{}',
      status: 'executing',
      decision: 'approved',
      reason: 'test-expired',
      context: {
        executionClaim: {
          owner: 'expired-owner',
          claimedAt: Date.now() - 10_000,
          leaseExpiresAt: Date.now() - 1_000,
        },
      },
    });

    const listed = await requestJson('/api/ingest/approvals');
    assert.equal(listed.status, 200);
    const recovered = store.getToolApprovalById(id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.decision, 'execution_outcome_unknown');
    assert.equal(recovered.reason, 'execution_outcome_unknown:lease_expired');

    const retry = await requestJson(`/api/ingest/approvals/${id}`, {
      method: 'POST', body: { decision: 'approved' },
    });
    assert.equal(retry.status, 409);
    assert.equal(store.getToolApprovalById(id).status, 'failed');
  });

  it('finalizes an approved route call with a bounded action outcome receipt', async () => {
    const queued = await queue('approved');
    const approved = await requestJson(`/api/ingest/approvals/${queued.approval.id}`, {
      method: 'POST', body: { decision: 'approved', workspaceId: 'ignored-decision-workspace' },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.ok, true);
    assert.equal(approved.body.approval.status, 'approved');
    assert.equal(approved.body.receipt.receiptKind, 'reviewed_action_receipt');
    // V4-B2B replaced the generic plugin-return labels with a bounded outcome
    // derived from the admission summary plus observed Graph evidence.
    assert.equal(approved.body.receipt.actionExecution, 'ingest_capability_executed');
    assert.ok(ACTION_OUTCOMES.includes(approved.body.receipt.actionOutcome));
    assert.notEqual(approved.body.receipt.actionOutcome, 'execution_outcome_unknown');
    assert.equal(approved.body.receipt.workspaceId, 'default');
    assert.equal(approved.body.receipt.metadata.snapshotHash, queued.approval.snapshotHash);
    assert.match(approved.body.receipt.metadata.pluginResultRef, /^sha256:/);
    assert.ok(approvalAudit(queued.approval.id, 'APPROVAL_APPROVED'));

    const durable = store.getToolApprovalById(queued.approval.id);
    assert.equal(durable.status, 'approved');
    assert.equal(durable.context.receipt.receiptId, approved.body.receipt.receiptId);

    // Superseded: the route no longer executes ingest inline. server.js now
    // delegates to the bounded action owner, which is the only caller.
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    assert.doesNotMatch(source, /await handleIngest\(/);
    assert.match(source, /await decideIngestApproval\(/);
    assert.doesNotMatch(source, /executeReviewedExternalGraphMutation/);
    assert.equal(VERDICT, 'V4_B2_EXISTING_RUNTIME_CONTRACT_BLOCKED_GAP');
  });
});
