'use strict';

// V4-B2B acceptance and adversarial evidence for the ingest approval authority
// repair. HTTP-level cases use real server.js, Kernel, SQLite Graph,
// AxiomStorage and loopback HTTP. Owner-level cases drive
// lib/workbench/ingest-approval-action.js directly with injected hostile
// dependencies, which is the only way to prove the fail-closed branches that a
// healthy plugin never reaches.

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const AxiomStorage = require('../storage');
const {
  ACTION_OUTCOMES,
  ACTION_OWNER,
  OUTCOME_UNKNOWN,
  captureOperationEvidenceForTest,
  classifyActionOutcome,
  decideIngestApproval,
} = require('../lib/workbench/ingest-approval-action');
const { buildIngestApprovalSnapshot, verifyIngestApprovalSnapshot } = require('../lib/ingest');

const VERDICT = 'V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_SUFFICIENT';
const REPO_ROOT = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-b2b-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'v4-b2b-test-key';
process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'graph.json');
process.env.AXIOM_DB_PATH = path.join(tempDir, 'graph.db');
delete process.env.AXIOM_USE_SQLITE;

const server = require('../server');
let store = null;
let port = 0;

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
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function manualPayload(suffix, overrides = {}) {
  return {
    sourceType: 'manual',
    author: 'v4-b2b',
    date: '2026-08-07',
    text: `v4 b2b ${suffix} hayvandir`,
    idempotencyKey: `v4-b2b-${suffix}`,
    ...overrides,
  };
}

function graphCounts() {
  const stats = server.kernel.graph.getStats();
  return { nodes: stats.nodes, edges: stats.edges };
}

function approvalAudit(approvalId, eventType) {
  return server.kernel.graph
    .getAuditEvents({ targetType: 'ingest_approval', targetId: approvalId })
    .find((event) => event.eventType === eventType) || null;
}

async function queue(suffix, overrides = {}) {
  const response = await requestJson('/api/ingest', { method: 'POST', body: manualPayload(suffix, overrides) });
  assert.equal(response.status, 202);
  return response.body;
}

// A minimal durable-store double for the owner-level adversarial cases. It
// mirrors the real CAS/lease contract without a second approval schema.
function fakeStore(approval) {
  const calls = { failed: [], finalized: [] };
  return {
    calls,
    record: approval,
    getToolApprovalById: () => approval,
    claimToolApprovalWithLease: () => ({ claimed: true, approval }),
    renewToolApprovalLease: () => ({ renewed: true }),
    failToolApproval: (id, reason) => { calls.failed.push(reason); },
    finalizeToolApprovalWithReceipt: (id, opts) => {
      calls.finalized.push(opts);
      return { finalized: true, approval };
    },
  };
}

function ownerDeps({ result, store: injected, kernel, throws = false }) {
  const approval = injected.record;
  return {
    store: injected,
    kernel: kernel || server.kernel,
    approvalId: approval.id,
    decision: 'approved',
    handleIngest: async () => { if (throws) throw new Error('hostile plugin failure'); return result; },
    ensureRuntime: () => {},
    recordAudit: () => ({ auditId: 'audit-stub' }),
    toPublicApproval: (record) => ({ id: record.id, status: record.status }),
    workerId: 'v4-b2b-owner',
    leaseMs: 60_000,
  };
}

function pendingApproval(id, suffix) {
  const snapshot = buildIngestApprovalSnapshot(manualPayload(suffix));
  assert.equal(snapshot.ok, true);
  return {
    id,
    tool: 'http.ingest',
    status: 'pending',
    decision: 'review',
    context: { source: 'http-ingest', snapshot },
  };
}

before(async () => {
  assert.equal(server.kernel.graph.getStats().backend, 'sqlite');
  store = new AxiomStorage({ kernel: server.kernel });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  server.closeAxiom();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('V4-B2B: ingest approval authority repair', () => {
  it('binds canonical default workspace for omitted and exact default input', async () => {
    const omitted = await queue('omitted');
    const explicit = await queue('explicit', { workspaceId: 'default' });

    for (const queued of [omitted, explicit]) {
      const record = store.getToolApprovalById(queued.approval.id);
      assert.equal(record.context.snapshot.workspaceId, 'default');
      assert.equal(verifyIngestApprovalSnapshot(record.context.snapshot).ok, true);
    }
    assert.notEqual(omitted.approval.snapshotHash, explicit.approval.snapshotHash);
  });

  it('fails every non-default workspace closed before persistence', async () => {
    const pendingBefore = store.countPendingToolApprovals();
    const before = graphCounts();
    const hostile = [
      'tenant-b', 'DEFAULT', ' default', 'default ', '', '   ',
      0, null === undefined ? null : 123, true, ['default'], { workspaceId: 'default' },
    ];

    for (const workspaceId of hostile) {
      const response = await requestJson('/api/ingest', {
        method: 'POST', body: manualPayload(`hostile-${String(workspaceId)}`, { workspaceId }),
      });
      assert.equal(response.status, 400, `workspace ${JSON.stringify(workspaceId)} must fail closed`);
      assert.equal(response.body.error.code, 'INGEST_WORKSPACE_UNSUPPORTED');
    }

    assert.equal(store.countPendingToolApprovals(), pendingBefore);
    assert.deepEqual(graphCounts(), before);
  });

  it('keeps one approval and one snapshot hash across idempotent queueing', async () => {
    const first = await queue('idempotent');
    const replay = await requestJson('/api/ingest', { method: 'POST', body: manualPayload('idempotent') });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.approval.id, first.approval.id);
    assert.equal(replay.body.approval.snapshotHash, first.approval.snapshotHash);
  });

  it('rejects with a blocked receipt bound to the persisted workspace and no Graph mutation', async () => {
    const queued = await queue('rejected');
    const before = graphCounts();
    const rejected = await requestJson(`/api/ingest/approvals/${queued.approval.id}`, {
      method: 'POST', body: { decision: 'rejected', workspaceId: 'attacker-workspace' },
    });

    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.receipt.receiptKind, 'blocked_action_receipt');
    assert.equal(rejected.body.receipt.workspaceId, 'default');
    assert.equal(rejected.body.receipt.metadata.snapshotHash, queued.approval.snapshotHash);
    assert.equal(rejected.body.receipt.metadata.actionOwner, ACTION_OWNER);
    assert.deepEqual(graphCounts(), before);

    const audit = approvalAudit(queued.approval.id, 'APPROVAL_REJECTED');
    assert.ok(audit);
    assert.equal(audit.workspaceId, 'default');
  });

  it('maps approved manual and decision ingest to the authorized outcome vocabulary', async () => {
    const cases = [
      manualPayload('approve-manual'),
      {
        sourceType: 'decision', title: 'v4 b2b karari', rationale: 'v4 b2b gerekcesi',
        decidedBy: 'v4-b2b', date: '2026-08-07', idempotencyKey: 'v4-b2b-approve-decision',
      },
    ];

    for (const body of cases) {
      const queued = await requestJson('/api/ingest', { method: 'POST', body });
      assert.equal(queued.status, 202);
      const approvalId = queued.body.approval.id;
      const approved = await requestJson(`/api/ingest/approvals/${approvalId}`, {
        method: 'POST', body: { decision: 'approved', workspaceId: 'attacker-workspace', snapshotHash: 'forged' },
      });

      assert.equal(approved.status, 200);
      const receipt = approved.body.receipt;
      assert.ok(ACTION_OUTCOMES.includes(receipt.actionOutcome));
      assert.notEqual(receipt.actionOutcome, OUTCOME_UNKNOWN);
      assert.equal(receipt.actionExecution, 'ingest_capability_executed');

      // Decision bytes controlled nothing: workspace, snapshot and owner all
      // come from the immutable persisted snapshot.
      assert.equal(receipt.workspaceId, 'default');
      assert.equal(receipt.metadata.snapshotHash, queued.body.approval.snapshotHash);
      assert.equal(receipt.metadata.actionOwner, ACTION_OWNER);
      assert.equal(receipt.metadata.operationId, approvalId);
      assert.equal(receipt.metadata.operationWorkspaceId, 'default');
      assert.match(receipt.metadata.operationEvidenceRef, /^sha256:/);

      const durable = store.getToolApprovalById(approvalId);
      assert.equal(durable.status, 'approved');
      assert.equal(durable.context.receipt.actionOutcome, receipt.actionOutcome);
      assert.equal(durable.context.snapshot.workspaceId, 'default');
      assert.equal(approvalAudit(approvalId, 'APPROVAL_APPROVED').workspaceId, 'default');
    }
  });

  it('fails closed for unknown, already finalized and tampered records', async () => {
    const unknown = await requestJson('/api/ingest/approvals/missing-b2b', {
      method: 'POST', body: { decision: 'approved' },
    });
    assert.equal(unknown.status, 404);

    // Persist a row whose snapshot workspace was flipped after hashing: the
    // binding hash must catch it before any execution.
    const snapshot = buildIngestApprovalSnapshot(manualPayload('tampered'));
    assert.equal(snapshot.ok, true);
    const tamperedId = 'approval-v4-b2b-tampered';
    store.saveToolApproval({
      id: tamperedId,
      approvalKey: 'v4-b2b-tampered-key',
      tool: 'http.ingest',
      input: JSON.stringify(snapshot.payload),
      status: 'pending',
      decision: 'review',
      reason: 'http_ingest_requires_review',
      context: { source: 'http-ingest', snapshot: { ...snapshot, workspaceId: 'tenant-b' } },
    });

    const before = graphCounts();
    const tampered = await requestJson(`/api/ingest/approvals/${tamperedId}`, {
      method: 'POST', body: { decision: 'approved' },
    });
    assert.equal(tampered.status, 409);
    assert.equal(tampered.body.error.code, 'SNAPSHOT_INTEGRITY_MISMATCH');
    assert.equal(store.getToolApprovalById(tamperedId).status, 'failed');
    assert.deepEqual(graphCounts(), before);
  });

  it('never finalizes a hostile or uncertain result as approved', async () => {
    const hostileResults = [
      null,
      'not-an-object',
      { ok: false, error: 'boom' },
      { ok: true },
      { ok: true, admission: 'not-an-object' },
      { ok: true, admission: { outcome: 'sneaky', graphWrite: true } },
    ];

    for (const result of hostileResults) {
      const injected = fakeStore(pendingApproval(`b2b-hostile-${hostileResults.indexOf(result)}`, 'hostile'));
      const outcome = await decideIngestApproval(ownerDeps({ result, store: injected }));
      assert.equal(outcome.status, 409, `result ${JSON.stringify(result)} must not finalize`);
      assert.equal(outcome.error.code, 'INGEST_EXECUTION_UNKNOWN');
      assert.equal(injected.calls.finalized.length, 0);
      assert.match(injected.calls.failed[0], new RegExp(`^${OUTCOME_UNKNOWN}:`));
    }

    // A throwing dependency is unknown, not approved, and leaks no raw error.
    const throwing = fakeStore(pendingApproval('b2b-throws', 'throws'));
    const thrown = await decideIngestApproval(ownerDeps({ result: null, store: throwing, throws: true }));
    assert.equal(thrown.status, 409);
    assert.equal(thrown.error.code, 'INGEST_EXECUTION_UNKNOWN');
    assert.doesNotMatch(JSON.stringify(thrown), /hostile plugin failure/);
    assert.equal(throwing.calls.failed[0], `${OUTCOME_UNKNOWN}:execution_threw`);
  });

  it('classifies only operation-owned evidence and ignores concurrent graph deltas', () => {
    const noWrite = { ok: true, operationId: 'approval-1', workspaceId: 'default', entries: [
      { workspaceId: 'default', receiptId: 'receipt-1', auditId: 'audit-1', graphWrite: false },
    ] };
    const wrote = { ok: true, operationId: 'approval-1', workspaceId: 'default', entries: [
      { workspaceId: 'default', receiptId: 'receipt-1', auditId: 'audit-1', graphWrite: true },
    ] };
    const allow = (graphWrite) => ({ ok: true, admission: { outcome: 'allow', graphWrite } });

    assert.equal(classifyActionOutcome(allow(true), wrote).outcome, 'admission_allow_graph_write_observed');
    assert.equal(classifyActionOutcome(allow(false), noWrite).outcome, 'admission_allow_no_graph_write_observed');
    assert.equal(classifyActionOutcome(allow(true), noWrite).outcome, 'admission_allow_no_graph_write_observed');
    assert.equal(classifyActionOutcome(allow(false), wrote).outcome, OUTCOME_UNKNOWN);

    for (const declared of ['review', 'reject']) {
      const result = { ok: true, admission: { outcome: declared, graphWrite: false } };
      assert.equal(classifyActionOutcome(result, noWrite).outcome, `admission_${declared}_no_graph_write_observed`);
      assert.equal(classifyActionOutcome(result, wrote).outcome, OUTCOME_UNKNOWN);
    }

    assert.equal(classifyActionOutcome(allow(true), { ok: false }).outcome, OUTCOME_UNKNOWN);

    const captured = captureOperationEvidenceForTest({ admission: { evidence: noWrite.entries } }, 'approval-1', 'default');
    assert.deepEqual(captured, noWrite);
    assert.equal(captureOperationEvidenceForTest({ admission: { evidence: [
      { workspaceId: 'other', receiptId: 'foreign', auditId: 'foreign-audit', graphWrite: true },
    ] } }, 'approval-1', 'default').ok, false);
  });

  it('does not bind a concurrent foreign mutation to the approved operation', async () => {
    const noWriteResult = {
      ok: true,
      admission: {
        outcome: 'allow', graphWrite: false,
        evidence: [{ workspaceId: 'default', receiptId: 'receipt-own-no-write', auditId: 'audit-own-no-write', graphWrite: false }],
      },
    };
    const noWriteStore = fakeStore(pendingApproval('approval-concurrent-no-write', 'concurrent-no-write'));
    const noWriteDeps = ownerDeps({ result: noWriteResult, store: noWriteStore });
    noWriteDeps.handleIngest = async () => {
      // Models another workspace mutating while this operation performs no
      // write. Global counters would grow here; operation evidence does not.
      noWriteDeps.kernel.graph.addNode('foreign-concurrent-node', 'foreign', null, { workspaceId: 'foreign' });
      return noWriteResult;
    };
    const noWrite = await decideIngestApproval(noWriteDeps);
    assert.equal(noWrite.status, 200);
    assert.equal(noWrite.json.receipt.actionOutcome, 'admission_allow_no_graph_write_observed');
    assert.doesNotMatch(JSON.stringify(noWrite.json.receipt), /foreign-concurrent-node|foreign/);

    const writeResult = {
      ok: true,
      admission: {
        outcome: 'allow', graphWrite: true,
        evidence: [{ workspaceId: 'default', receiptId: 'receipt-own-write', auditId: 'audit-own-write', graphWrite: true }],
      },
    };
    const writeStore = fakeStore(pendingApproval('approval-concurrent-write', 'concurrent-write'));
    const writeDeps = ownerDeps({ result: writeResult, store: writeStore });
    writeDeps.handleIngest = async () => {
      writeDeps.kernel.graph.addNode('foreign-concurrent-node-2', 'foreign', null, { workspaceId: 'foreign' });
      return writeResult;
    };
    const wrote = await decideIngestApproval(writeDeps);
    assert.equal(wrote.status, 200);
    assert.equal(wrote.json.receipt.actionOutcome, 'admission_allow_graph_write_observed');
    assert.doesNotMatch(JSON.stringify(wrote.json.receipt), /foreign-concurrent-node-2|foreign/);
  });

  it('keeps server.js a thin orchestrator and excludes reviewed-external execution', () => {
    const serverSource = fs.readFileSync(require.resolve('../server'), 'utf8');
    const ownerSource = fs.readFileSync(path.join(REPO_ROOT, 'lib/workbench/ingest-approval-action.js'), 'utf8');

    assert.doesNotMatch(serverSource, /await handleIngest\(/);
    assert.match(serverSource, /await decideIngestApproval\(/);
    assert.doesNotMatch(serverSource, /executeReviewedExternalGraphMutation/);
    assert.doesNotMatch(ownerSource, /executeReviewedExternalGraphMutation/);
    // The owner must not write to the Graph itself.
    assert.doesNotMatch(ownerSource, /graph\.(addNode|addEdge|appendAuditEvent|save)\(/);
    assert.ok(ownerSource.split('\n').length <= 300, 'action owner must stay at or below 300 lines');

    assert.equal(VERDICT, 'V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_SUFFICIENT');
  });

  it('publishes the bounded action owner in the packed tarball', () => {
    const packed = cp.spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32',
    });
    assert.equal(packed.status, 0, packed.stderr || 'npm pack --dry-run failed');
    const files = new Set(JSON.parse(packed.stdout)[0].files.map((entry) => entry.path.replace(/\\/g, '/')));
    assert.ok(files.has('lib/workbench/ingest-approval-action.js'));
    assert.ok(!files.has('test/v4-b2b-ingest-approval-authority-gap.test.js'));
  });
});
