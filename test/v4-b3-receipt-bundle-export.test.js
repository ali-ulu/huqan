'use strict';

/**
 * V4-B3 — Receipt bundle export user-flow acceptance.
 *
 * Real server.js, real Kernel, real SQLite-backed Graph, real loopback HTTP.
 * The adversarial half is deliberately not asserted through the happy path:
 * verification failure, chain corruption and both ceilings are each forced.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-b3-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'v4-b3-test-key';
process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
process.env.AXIOM_DB_PATH = path.join(tempDir, 'graph.db');

const server = require('../server');
const { verifyExportedBundle } = require('../lib/receipt/receipt-export');
const {
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  exportWorkbenchReceiptBundle,
} = require('../lib/workbench/receipt-bundle-exporter');
const {
  ROUTE_PATHNAME,
  handleWorkbenchReceiptBundleRequest,
} = require('../lib/workbench/receipt-bundle-export-route');
const {
  listAuthenticatedRouteIds,
  resolveRouteAuthPolicy,
} = require('../lib/http/route-auth-policy');
const {
  exportMaterializedReceiptBundleBounded,
} = require('../lib/receipt/bounded-receipt-export');

let baseUrl;
let httpServer;

function admissionOpts(workspaceId, seq) {
  return {
    workspaceId,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr-v4-b3-${seq}`,
    provenance: {
      provenanceId: `prov-v4-b3-${seq}`,
      sourceType: 'test',
      sourceRef: 'test:v4-b3-receipt-bundle-export',
      actor: 'v4-b3-acceptance',
      workspaceId,
      timestamp: new Date().toISOString(),
      trustPolicyVersion: '1.0.0',
    },
  };
}

function request(pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: httpServer.address().port,
      path: pathname,
      method: opts.method || 'GET',
      headers: opts.auth === false
        ? {}
        : { Authorization: `Bearer ${process.env.AXIOM_API_KEY}` },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw,
        body: raw ? JSON.parse(raw) : null,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A synthetic materialized receipt, shaped exactly like the admission path emits. */
function syntheticReceipt(seq, metadata = {}) {
  return {
    receiptId: `rcpt-v4-b3-${String(seq).padStart(5, '0')}`,
    receiptKind: 'admission',
    decision: 'allow',
    status: 'recorded',
    admissionId: `adm-v4-b3-${seq}`,
    workspaceId: 'default',
    provenanceId: `prov-v4-b3-${seq}`,
    trustPolicyVersion: '1.0.0',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq % 60)).toISOString(),
    metadata,
  };
}

/** An in-memory audit source the bounded seam accepts, without touching SQLite. */
function syntheticSource(count, metadataFor = () => ({})) {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push({
      auditId: `aud-v4-b3-${String(i).padStart(5, '0')}`,
      eventType: 'receipt_materialized',
      targetType: 'receipt',
      targetId: `rcpt-v4-b3-${String(i).padStart(5, '0')}`,
      workspaceId: 'default',
      actor: 'system',
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
      details: { receipt: syntheticReceipt(i, metadataFor(i)) },
    });
  }
  return events;
}

before(async () => {
  // server.js exports the real http.Server; AXIOM_DISABLE_AUTO_LISTEN keeps it
  // unbound until the test binds it to an ephemeral loopback port.
  httpServer = server;
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer && httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('V4-B3: receipt bundle export — route declaration', () => {
  it('the route is declared in the central auth policy', () => {
    assert.ok(listAuthenticatedRouteIds().includes('workbench-receipt-bundle'));
    const decision = resolveRouteAuthPolicy(ROUTE_PATHNAME, 'GET');
    assert.equal(decision.known, true);
    assert.equal(decision.authRequired, true);
  });

  it('an undeclared neighbouring path stays unknown, so it cannot become a 401', () => {
    for (const neighbour of [
      '/api/workbench/receipt-bundles',
      '/api/workbench/receipt-bundle/extra',
      '/api/workbench/receipt',
    ]) {
      const decision = resolveRouteAuthPolicy(neighbour, 'GET');
      assert.equal(decision.known, false, `${neighbour} must not be a declared route`);
      assert.equal(decision.authRequired, false);
    }
  });
});

describe('V4-B3: receipt bundle export — empty state before any receipt exists', () => {
  it('a caller with zero receipts receives 200 and an empty verified bundle, not 404', async () => {
    const res = await request(ROUTE_PATHNAME);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, 'exported');
    assert.equal(res.body.receiptCount, 0);
    assert.deepEqual(res.body.bundle.receipts, []);
    assert.equal(verifyExportedBundle(res.body.bundle).valid, true);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});

describe('V4-B3: receipt bundle export — authenticated happy path', () => {
  before(() => {
    for (let i = 0; i < 4; i += 1) {
      const result = server.kernel.learn(`v4b3kavram${i} bir testtir`, admissionOpts('default', i));
      assert.equal(result.data?.admission?.outcome, 'allow');
    }
  });

  it('omitted workspaceId returns 200 with a bundle verifyExportedBundle() accepts', async () => {
    const res = await request(ROUTE_PATHNAME);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'exported');
    assert.ok(res.body.receiptCount >= 4);
    assert.equal(res.body.verified, true);
    assert.equal(verifyExportedBundle(res.body.bundle).valid, true);
  });

  it('exact default workspaceId returns 200 and the identical bundle', async () => {
    const omitted = await request(ROUTE_PATHNAME);
    const explicit = await request(`${ROUTE_PATHNAME}?workspaceId=default`);
    assert.equal(explicit.status, 200);
    assert.equal(verifyExportedBundle(explicit.body.bundle).valid, true);
    assert.deepEqual(
      explicit.body.bundle.receipts,
      omitted.body.bundle.receipts,
      'omitted and exact-default must read the same canonical workspace',
    );
  });

  it('the exported bundle is byte-identical to the unredacted source bundle', async () => {
    const res = await request(`${ROUTE_PATHNAME}?workspaceId=default`);
    const direct = exportMaterializedReceiptBundleBounded(server.kernel.graph, {
      workspaceId: 'default',
      exportedAt: res.body.bundle.exportedAt,
    });
    assert.equal(direct.ok, true);
    assert.deepEqual(res.body.bundle, direct.bundle, 'no field may be stripped, masked or reshaped');
    assert.equal(res.body.bundle.bundleHash, direct.bundle.bundleHash);
  });

  it('success carries the required security headers and leaks no internal detail', async () => {
    const res = await request(ROUTE_PATHNAME);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.doesNotMatch(res.raw, /\bat\s+\/|node_modules|\.js:\d+:\d+|SQLITE_|Error:/);
  });

  it('an unauthenticated request is denied and returns no bundle', async () => {
    const res = await request(ROUTE_PATHNAME, { auth: false });
    assert.ok(res.status === 401 || res.status === 403, `expected a denial, got ${res.status}`);
    assert.equal(res.body?.bundle, undefined);
  });

  it('a non-GET method is rejected', async () => {
    const res = await request(ROUTE_PATHNAME, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.body?.bundle, undefined);
  });
});

describe('V4-B3: receipt bundle export — workspace authority fails closed before any read', () => {
  const rejected = [
    ['blank', ''],
    ['padded left', '%20default'],
    ['padded right', 'default%20'],
    ['upper case', 'DEFAULT'],
    ['mixed case', 'Default'],
    ['numeric', '1'],
    ['boolean', 'true'],
    ['null literal', 'null'],
    ['other workspace', 'tenant-a'],
    ['array form', 'default&workspaceId=default'],
    ['object form', '%7B%22workspaceId%22%3A%22default%22%7D'],
    ['path traversal', '..%2Fdefault'],
  ];

  for (const [label, value] of rejected) {
    it(`${label} fails closed with 400 and no bundle`, async () => {
      const res = await request(`${ROUTE_PATHNAME}?workspaceId=${value}`);
      assert.equal(res.status, 400, `${label} must be rejected`);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.bundle, undefined);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });
  }

  it('non-string workspace values are rejected at the owner without reading the source', () => {
    const exploded = () => { throw new Error('source must not be read'); };
    for (const value of [null, 0, 1, true, false, [], ['default'], {}, { workspaceId: 'default' }]) {
      const outcome = exportWorkbenchReceiptBundle({
        workspaceId: value,
        source: { get _auditEvents() { return exploded(); } },
      });
      assert.equal(outcome.ok, false, `${JSON.stringify(value)} must fail closed`);
      assert.equal(outcome.status, 'invalid_request');
      assert.equal(outcome.error.code, 'WORKSPACE_NOT_ALLOWED');
      assert.equal(outcome.bundle, undefined);
    }
  });
});

describe('V4-B3: receipt bundle export — forced failure branches', () => {
  it('a bundle that fails verifyExportedBundle() returns 409 and no body, proved by forcing it', () => {
    const forced = handleWorkbenchReceiptBundleRequest({
      source: {},
      exportBundle: () => ({
        ok: true,
        status: 'exported',
        bundle: { schemaVersion: 'v4-receipt-bundle-v1', receiptCount: 1, bundleHash: 'tampered', receipts: [{}] },
        serializedBytes: 128,
        verification: { valid: false },
      }),
    });
    assert.equal(forced.statusCode, 409);
    assert.equal(forced.body.ok, false);
    assert.equal(forced.body.error.code, 'BUNDLE_VERIFICATION_FAILED');
    assert.equal(forced.body.bundle, undefined);
  });

  it('a corrupted chain returns 409 and no bundle', () => {
    const source = syntheticSource(3);
    source[1].details.receipt.receiptId = '';
    const outcome = exportWorkbenchReceiptBundle({ source });
    assert.equal(outcome.ok, true, 'a blank receiptId is skipped, not fatal');

    const broken = syntheticSource(3);
    broken[2].details.receipt.decision = 'not-a-canonical-decision';
    const brokenOutcome = handleWorkbenchReceiptBundleRequest({ source: broken });
    assert.equal(brokenOutcome.statusCode, 409);
    assert.equal(brokenOutcome.body.ok, false);
    assert.equal(brokenOutcome.body.bundle, undefined);
  });

  it('exceeding MAX_RECEIPTS returns 413 with no partial bundle', () => {
    const source = syntheticSource(MAX_RECEIPTS + 1);
    const result = handleWorkbenchReceiptBundleRequest({ source });
    assert.equal(result.statusCode, 413);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'MAX_RECEIPTS_EXCEEDED');
    assert.equal(result.body.error.maxReceipts, MAX_RECEIPTS);
    assert.equal(result.body.bundle, undefined);
    assert.equal(result.body.limits.maxReceipts, MAX_RECEIPTS);
  });

  it('staying at exactly MAX_RECEIPTS still exports', () => {
    const result = handleWorkbenchReceiptBundleRequest({ source: syntheticSource(MAX_RECEIPTS) });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.receiptCount, MAX_RECEIPTS);
    assert.equal(verifyExportedBundle(result.body.bundle).valid, true);
  });

  it('exceeding MAX_SERIALIZED_BUNDLE_BYTES returns 413 from actual serialized bytes', () => {
    const filler = 'x'.repeat(64 * 1024);
    const source = syntheticSource(64, () => ({ filler }));
    const result = handleWorkbenchReceiptBundleRequest({ source });
    assert.equal(result.statusCode, 413);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED');
    assert.equal(result.body.bundle, undefined);
    assert.equal(result.body.limits.maxSerializedBundleBytes, MAX_SERIALIZED_BUNDLE_BYTES);
  });

  it('a read failure maps to 502 without forwarding the underlying message', () => {
    const result = handleWorkbenchReceiptBundleRequest({
      source: {},
      exportBundle: () => { throw Object.assign(new Error('SQLITE_CORRUPT: /private/db/graph.db row 41'), { code: 'SQLITE_CORRUPT' }); },
    });
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.error.code, 'RECEIPT_BUNDLE_READ_FAILED');
    assert.doesNotMatch(JSON.stringify(result.body), /SQLITE_CORRUPT|private\/db|row 41/);
    assert.equal(result.body.bundle, undefined);
  });

  it('every failure status maps to its contracted HTTP code', () => {
    const cases = [
      ['invalid_request', 400, { ok: false, status: 'invalid_request', error: { code: 'WORKSPACE_NOT_ALLOWED' } }],
      ['invalid', 409, { ok: false, status: 'invalid', error: { code: 'INVALID_RECEIPT_CHAIN' } }],
      ['limit_exceeded', 413, { ok: false, status: 'limit_exceeded', error: { code: 'MAX_RECEIPTS_EXCEEDED' } }],
      ['read_error', 502, { ok: false, status: 'read_error', error: { code: 'BOUNDED_AUDIT_READ_FAILED' } }],
    ];
    for (const [label, expected, outcome] of cases) {
      const result = handleWorkbenchReceiptBundleRequest({ source: {}, exportBundle: () => outcome });
      assert.equal(result.statusCode, expected, `${label} must map to ${expected}`);
      assert.equal(result.body.bundle, undefined);
    }
  });
});

describe('V4-B3: receipt bundle export — router header contract on every status', () => {
  const {
    createWorkbenchReadHttpRouter,
  } = require('../lib/workbench/workbench-read-http-router');

  function dispatch(graph, search = '') {
    const captured = [];
    const router = createWorkbenchReadHttpRouter({
      writeJson: (_req, _res, statusCode, body, headers) => captured.push({ statusCode, body, headers }),
      writeApiError: () => {},
      denyIfUnauthorized: () => true,
      readTrustFilters: () => ({}),
      readReceiptById: () => null,
    });
    const reqUrl = new URL(`http://127.0.0.1${ROUTE_PATHNAME}${search}`);
    const handled = router({ method: 'GET' }, {}, reqUrl, graph);
    return { handled, ...captured[0] };
  }

  it('413 carries no-store and nosniff and no bundle', () => {
    const result = dispatch(syntheticSource(MAX_RECEIPTS + 1));
    assert.equal(result.handled, true);
    assert.equal(result.statusCode, 413);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(result.body.bundle, undefined);
  });

  it('409 carries no-store and nosniff and no bundle', () => {
    const broken = syntheticSource(2);
    broken[1].details.receipt.decision = 'not-a-canonical-decision';
    const result = dispatch(broken);
    assert.equal(result.statusCode, 409);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(result.body.bundle, undefined);
  });

  it('400 carries no-store and nosniff, and repeated workspaceId is rejected', () => {
    const rejectedSearch = dispatch(syntheticSource(1), '?workspaceId=tenant-a');
    assert.equal(rejectedSearch.statusCode, 400);
    assert.equal(rejectedSearch.headers['Cache-Control'], 'no-store');
    assert.equal(rejectedSearch.headers['X-Content-Type-Options'], 'nosniff');

    const repeated = dispatch(syntheticSource(1), '?workspaceId=default&workspaceId=default');
    assert.equal(repeated.statusCode, 400);
    assert.equal(repeated.headers['Cache-Control'], 'no-store');
    assert.equal(repeated.body.bundle, undefined);
  });

  it('200 carries no-store and nosniff', () => {
    const result = dispatch(syntheticSource(2));
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(verifyExportedBundle(result.body.bundle).valid, true);
  });

  it('an unrelated workbench path is not claimed by this route', () => {
    const router = createWorkbenchReadHttpRouter({
      writeJson: () => {},
      writeApiError: () => {},
      denyIfUnauthorized: () => true,
      readTrustFilters: () => ({}),
      readReceiptById: () => null,
    });
    const reqUrl = new URL('http://127.0.0.1/api/workbench/receipt-bundles');
    assert.equal(router({ method: 'GET' }, {}, reqUrl, syntheticSource(1)), false);
  });
});

describe('V4-B3: receipt bundle export — surface containment', () => {
  it('no CLI, MCP or UI surface is added by this work', () => {
    const forbidden = [
      { file: 'cli.js', needle: 'receipt-bundle' },
      { file: 'mcpServer.js', needle: 'receipt-bundle' },
      { file: 'public/index.html', needle: 'receipt-bundle' },
    ];
    for (const { file, needle } of forbidden) {
      const full = path.join(__dirname, '..', file);
      if (!fs.existsSync(full)) continue;
      assert.equal(fs.readFileSync(full, 'utf8').includes(needle), false,
        `${file} must not gain a ${needle} surface`);
    }
  });

  it('the package allowlist ships both new modules', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(pkg.files.includes('lib/workbench/receipt-bundle-exporter.js'));
    assert.ok(pkg.files.includes('lib/workbench/receipt-bundle-export-route.js'));
  });
});
