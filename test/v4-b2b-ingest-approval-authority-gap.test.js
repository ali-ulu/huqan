'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const AxiomStorage = require('../storage');
const { buildIngestApprovalSnapshot } = require('../lib/ingest');
const { decideIngestApproval, OUTCOMES } = require('../lib/workbench/ingest-approval-action');

const VERDICT = 'V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_SUFFICIENT';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-b2b-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'v4-b2b-test-key';
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

class AuthorityTestCLI extends CLI {
  constructor(...args) {
    super(...args);
    serverCli = this;
  }
}

try {
  require.cache[cliModulePath].exports = AuthorityTestCLI;
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
        Authorization: `Bearer ${process.env.AXIOM_API_KEY}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function manual(suffix, overrides = {}) {
  return {
    sourceType: 'manual',
    author: 'v4-b2b',
    date: '2026-08-05',
    text: `v4 b2b ${suffix} guvenilir sistemdir`,
    idempotencyKey: `v4-b2b-${suffix}`,
    ...overrides,
  };
}

function graphCounts() {
  return {
    nodes: serverCli.kernel.graph.nodeCount('default'),
    edges: serverCli.kernel.graph.edgeCount('default'),
  };
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

describe('V4-B2B canonical approval authority repair', () => {
  it('binds omitted/exact default workspace and rejects every non-canonical form', () => {
    for (const input of [manual('omitted'), manual('exact', { workspaceId: 'default' }), manual('alias', { workspace_id: 'default' })]) {
      const snapshot = buildIngestApprovalSnapshot(input);
      assert.equal(snapshot.ok, true);
      assert.equal(snapshot.payload.workspaceId, 'default');
      assert.match(snapshot.snapshotHash, /^sha256:/);
    }

    for (const workspace of ['tenant-a', '', ' default', 'default ', 7, null, {}]) {
      const snapshot = buildIngestApprovalSnapshot(manual(`bad-${String(workspace)}`, { workspaceId: workspace }));
      assert.equal(snapshot.ok, false);
      assert.equal(snapshot.code, 'INGEST_WORKSPACE_NOT_AUTHORIZED');
    }
    const conflicting = buildIngestApprovalSnapshot(manual('conflict', {
      workspaceId: 'default',
      workspace_id: 'tenant-b',
    }));
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.code, 'INGEST_WORKSPACE_NOT_AUTHORIZED');
  });

  it('fails non-default HTTP queueing before persistence and preserves zero preapproval mutation', async () => {
    const pendingBefore = store.countPendingToolApprovals();
    const graphBefore = graphCounts();
    const denied = await requestJson('/api/ingest', {
      method: 'POST',
      body: manual('route-denied', { workspaceId: 'tenant-a' }),
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'INGEST_WORKSPACE_NOT_AUTHORIZED');
    assert.equal(store.countPendingToolApprovals(), pendingBefore);
    assert.deepEqual(graphCounts(), graphBefore);

    const queued = await requestJson('/api/ingest', {
      method: 'POST',
      body: manual('route-default'),
    });
    assert.equal(queued.status, 202);
    const durable = store.getToolApprovalById(queued.body.approval.id);
    assert.equal(durable.context.snapshot.payload.workspaceId, 'default');
    assert.equal(queued.body.approval.workspaceId, 'default');
    assert.deepEqual(graphCounts(), graphBefore);

    const rejected = await requestJson(`/api/ingest/approvals/${queued.body.approval.id}`, {
      method: 'POST',
      body: { decision: 'rejected', workspaceId: 'tenant-override' },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.receipt.workspaceId, 'default');
    assert.equal(rejected.body.receipt.metadata.snapshotHash, queued.body.approval.snapshotHash);
    assert.equal(rejected.body.receipt.metadata.actionOwner, 'workbench.ingest-approval-action');
    assert.deepEqual(graphCounts(), graphBefore);
  });

  it('persists unknown outcome on malformed execution evidence and never retries it', async () => {
    const snapshot = buildIngestApprovalSnapshot(manual('unknown'));
    assert.equal(snapshot.ok, true);
    const id = 'v4-b2b-unknown-approval';
    store.saveToolApproval({
      id,
      approvalKey: 'v4-b2b-unknown-key',
      tool: 'http.ingest',
      input: JSON.stringify(snapshot.payload),
      status: 'pending',
      decision: 'review',
      reason: 'test',
      context: { source: 'test', snapshot },
      policy: { action: 'ingest', approval: 'review' },
    });
    let calls = 0;
    const first = await decideIngestApproval({
      approvalId: id,
      decision: 'approved',
      store,
      kernel: serverCli.kernel,
      ensureRuntime: async () => {},
      workerId: 'v4-b2b-test-worker',
      leaseMs: 60_000,
      execute: async () => {
        calls += 1;
        return { ok: true, ingestMeta: {}, admission: {} };
      },
    });
    assert.equal(first.statusCode, 409);
    assert.equal(first.body.error.code, 'INGEST_EXECUTION_UNKNOWN');
    assert.equal(calls, 1);
    assert.equal(store.getToolApprovalById(id).status, 'failed');

    const retry = await decideIngestApproval({
      approvalId: id,
      decision: 'approved',
      store,
      kernel: serverCli.kernel,
      ensureRuntime: async () => {},
      workerId: 'v4-b2b-test-worker-2',
      leaseMs: 60_000,
      execute: async () => { calls += 1; return null; },
    });
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.body.error.code, 'APPROVAL_OUTCOME_UNKNOWN');
    assert.equal(calls, 1);
  });

  it('keeps server thin, package-reachable and bounded to the authorized owner', () => {
    const serverSource = fs.readFileSync(require.resolve('../server'), 'utf8');
    const ownerSource = fs.readFileSync(require.resolve('../lib/workbench/ingest-approval-action'), 'utf8');
    const pkg = require('../package.json');
    assert.match(serverSource, /decideIngestApproval\(/);
    assert.doesNotMatch(serverSource, /result = await handleIngest\(/);
    assert.doesNotMatch(serverSource, /executeReviewedExternalGraphMutation/);
    assert.match(ownerSource, /result = await execute\(/);
    assert.doesNotMatch(ownerSource, /executeReviewedExternalGraphMutation/);
    assert.ok(pkg.files.includes('lib/workbench/ingest-approval-action.js'));
    assert.ok(Object.values(OUTCOMES).includes('execution_outcome_unknown'));
    assert.equal(VERDICT, 'V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_SUFFICIENT');
  });
});
