'use strict';

// V4-B3 acceptance and adversarial evidence for the receipt bundle export user
// flow. HTTP cases use real server.js, Kernel, SQLite Graph and loopback HTTP.
// Owner-level cases drive lib/workbench/receipt-bundle-exporter.js directly,
// which is the only way to reach branches a healthy source never produces.

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const {
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  exportReceiptBundle,
  _test: exporterInternals,
} = require('../lib/workbench/receipt-bundle-exporter');
const { verifyExportedBundle } = require('../lib/receipt/receipt-export');
const { exportMaterializedReceiptBundle } = require('../lib/receipt/receipt-read-index');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');

const VERDICT = 'V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT';
const REPO_ROOT = path.resolve(__dirname, '..');
const ROUTE = '/api/workbench/receipt-bundle';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-b3-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'v4-b3-test-key';
process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'graph.json');
process.env.AXIOM_DB_PATH = path.join(tempDir, 'graph.db');
delete process.env.AXIOM_USE_SQLITE;

// server.js owns its kernel directly since #326; it is deliberately no longer
// reachable by intercepting a CLI instance server.js used to build. Read it
// through the published `server.kernel` seam, matching the sibling V4-B2B test.
const server = require('../server');
let port = 0;

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.auth === false ? {} : { Authorization: `Bearer ${process.env.AXIOM_API_KEY}` },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
        resolve({ status: response.statusCode, body: parsed, headers: response.headers, raw: text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function learnApproved(index) {
  const result = server.kernel.learn(`v4b3kedi${index} hayvandir`, {
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr-v4-b3-${index}`,
    provenance: {
      provenanceId: `prov-v4-b3-${index}`,
      sourceType: 'test',
      sourceRef: 'test:v4-b3',
      actor: 'v4-b3-test',
      workspaceId: 'default',
      timestamp: new Date().toISOString(),
      trustPolicyVersion: '1.0.0',
    },
  });
  assert.equal(result.ok, true);
  return result;
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

// A source whose audit read is huge but whose export primitive would throw if
// reached. Reaching 413 through it proves the count ceiling is decided before
// materialization.
function oversizedSource(count) {
  const events = [];
  for (let i = 0; i < count; i++) {
    events.push({ auditId: `a${i}`, workspaceId: 'default', details: { receipt: { receiptId: `r${i}` } } });
  }
  return {
    getAuditEvents: () => events,
    getNodes() { throw new Error('export primitive must not be reached'); },
    getEdges() { throw new Error('export primitive must not be reached'); },
  };
}

before(async () => {
  assert.equal(server.kernel.graph.getStats().backend, 'sqlite');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  server.closeAxiom();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('V4-B3: receipt bundle export user flow', () => {
  it('returns 200 and an empty verified bundle when no receipts exist', async () => {
    const response = await request(ROUTE);
    assert.equal(response.status, 200, 'absence of receipts is a truthful state, not a missing resource');
    assertSecurityHeaders(response);
    assert.equal(response.body.data.receiptCount, 0);
    assert.equal(verifyExportedBundle(response.body.data.bundle).valid, true);
  });

  it('exports a verified bundle for omitted and exact default workspace', async () => {
    for (let i = 0; i < 3; i++) learnApproved(i);

    const omitted = await request(ROUTE);
    const explicit = await request(`${ROUTE}?workspaceId=default`);

    for (const response of [omitted, explicit]) {
      assert.equal(response.status, 200);
      assertSecurityHeaders(response);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.data.workspaceId, 'default');
      assert.ok(response.body.data.receiptCount >= 3);
      assert.equal(response.body.data.chainStatus, 'valid');
      assert.equal(verifyExportedBundle(response.body.data.bundle).valid, true);
    }
    // exportedAt is a per-call envelope timestamp, so the comparison is over the
    // hash-sealed content that actually carries the trust semantics.
    assert.deepEqual(omitted.body.data.bundle.receipts, explicit.body.data.bundle.receipts);
    assert.equal(omitted.body.data.bundle.bundleHash, explicit.body.data.bundle.bundleHash);
  });

  it('returns the unredacted bundle byte for byte', async () => {
    const response = await request(ROUTE);
    const direct = exportMaterializedReceiptBundle(server.kernel.graph, { workspaceId: 'default' });
    assert.equal(direct.ok, true);

    // Everything except the per-call exportedAt timestamp must match the
    // unredacted source bundle exactly, including the seal over its receipts.
    const served = response.body.data.bundle;
    assert.deepEqual(served.receipts, direct.bundle.receipts, 'no field may be stripped, masked or reshaped');
    assert.equal(served.bundleHash, direct.bundle.bundleHash);
    assert.equal(served.schemaVersion, direct.bundle.schemaVersion);
    assert.equal(served.receiptCount, direct.bundle.receiptCount);
    assert.equal(served.workspaceId, direct.bundle.workspaceId);
    assert.deepEqual(
      Object.keys(served).sort(),
      Object.keys(direct.bundle).sort(),
      'the served bundle must carry exactly the source fields',
    );
    assert.equal(
      response.body.data.serializedBytes,
      Buffer.byteLength(JSON.stringify(served), 'utf8'),
      'reported bytes must be the actual serialized UTF-8 payload',
    );
  });

  it('denies unauthenticated access and keeps undeclared paths at 404', async () => {
    const denied = await request(ROUTE, { auth: false });
    assert.equal(denied.status, 401);

    const undeclared = await request('/api/workbench/receipt-bundle-extra', { auth: false });
    assert.equal(undeclared.status, 404, 'an undeclared path must not leak its existence through 401');

    const wrongMethod = await request(ROUTE, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assertSecurityHeaders(wrongMethod);
  });

  it('fails every non-default workspace closed with 400', async () => {
    const hostile = ['tenant-b', 'DEFAULT', ' default', 'default ', '', '  ', '0', 'default%00'];
    for (const workspaceId of hostile) {
      const response = await request(`${ROUTE}?workspaceId=${encodeURIComponent(workspaceId)}`);
      assert.equal(response.status, 400, `workspace ${JSON.stringify(workspaceId)} must fail closed`);
      assert.equal(response.body.error.code, 'WORKSPACE_UNSUPPORTED');
      assertSecurityHeaders(response);
      assert.equal(response.body.data, undefined, 'no bundle may accompany a refusal');
    }
  });

  it('decides the count ceiling before the export primitive materializes anything', () => {
    const result = exportReceiptBundle({ source: oversizedSource(MAX_RECEIPTS + 1) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
    assert.equal(result.error.code, 'RECEIPT_COUNT_CEILING_EXCEEDED');
    assert.equal(result.bundle, undefined, 'no partial bundle may be returned');

    // Exactly at the ceiling the primitive is reached, proving the refusal above
    // came from the ceiling rather than from the throwing stub.
    const atCeiling = exportReceiptBundle({ source: oversizedSource(MAX_RECEIPTS) });
    assert.notEqual(atCeiling.status, 413);
  });

  it('abandons byte measurement before assembling an oversized bundle', () => {
    const receipt = { receiptId: 'r', filler: 'x'.repeat(4096) };
    const oversized = { receipts: new Array(1024).fill(receipt) };
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversized.receipts), 'utf8') > MAX_SERIALIZED_BUNDLE_BYTES,
      'fixture must actually exceed the ceiling',
    );
    assert.equal(exporterInternals.measureSerializedBundle(oversized).ok, false);

    const small = { receipts: [{ receiptId: 'r', filler: 'x' }] };
    const measured = exporterInternals.measureSerializedBundle(small);
    assert.equal(measured.ok, true);
    assert.equal(measured.bytes, Buffer.byteLength(JSON.stringify(small), 'utf8'));
  });

  it('returns no bundle when the chain is invalid or verification fails', () => {
    const brokenChain = {
      getAuditEvents: () => [
        { auditId: 'a1', workspaceId: 'default', details: { receipt: { receiptId: 'r1', receiptKind: 'nonsense' } } },
      ],
    };
    const invalid = exportReceiptBundle({ source: brokenChain });
    assert.equal(invalid.ok, false);
    assert.ok([409, 502].includes(invalid.status));
    assert.equal(invalid.bundle, undefined);

    const unreadable = { getAuditEvents() { throw new Error('source exploded'); } };
    const readError = exportReceiptBundle({ source: unreadable });
    assert.equal(readError.ok, false);
    assert.equal(readError.status, 502);
    assert.doesNotMatch(JSON.stringify(readError), /source exploded/, 'no raw exception may leak');
  });

  it('declares the route centrally and adds no CLI, MCP or UI surface', () => {
    const policy = resolveRouteAuthPolicy(ROUTE, 'GET', {});
    assert.equal(policy.known, true);
    assert.equal(policy.authRequired, true);

    const cliSource = fs.readFileSync(path.join(REPO_ROOT, 'cli.js'), 'utf8');
    const mcpSource = fs.readFileSync(path.join(REPO_ROOT, 'mcpServer.js'), 'utf8');
    const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
    for (const source of [cliSource, mcpSource]) {
      assert.doesNotMatch(source, /receipt-bundle/, 'B3 adds no CLI or MCP surface');
    }
    assert.doesNotMatch(serverSource, /receipt-bundle/, 'server.js stays out of scope');

    const ownerSource = fs.readFileSync(path.join(REPO_ROOT, 'lib/workbench/receipt-bundle-exporter.js'), 'utf8');
    const routeSource = fs.readFileSync(path.join(REPO_ROOT, 'lib/workbench/receipt-bundle-export-route.js'), 'utf8');
    assert.ok(ownerSource.split('\n').length <= 200, 'owner must stay at or below 200 lines');
    assert.ok(routeSource.split('\n').length <= 200, 'route must stay at or below 200 lines');
    assert.equal(VERDICT, 'V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT');
  });

  it('publishes both bounded modules in the packed tarball', () => {
    const packed = cp.spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32',
    });
    assert.equal(packed.status, 0, packed.stderr || 'npm pack --dry-run failed');
    const files = new Set(JSON.parse(packed.stdout)[0].files.map((entry) => entry.path.replace(/\\/g, '/')));
    assert.ok(files.has('lib/workbench/receipt-bundle-exporter.js'));
    assert.ok(files.has('lib/workbench/receipt-bundle-export-route.js'));
    assert.ok(!files.has('test/v4-b3-receipt-bundle-export.test.js'));
  });
});
