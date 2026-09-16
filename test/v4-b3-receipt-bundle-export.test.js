'use strict';

/**
 * V4-B3 — Receipt bundle export user flow.
 *
 * Real server.js, real Kernel, real SQLite Graph and loopback HTTP for the
 * acceptance surface, plus owner-level adversarial evidence for the ceilings,
 * the verification gate and the workspace boundary.
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
process.env.AXIOM_USE_SQLITE = 'true';

const server = require('../server');

const {
  CANONICAL_WORKSPACE_ID,
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  exportWorkbenchReceiptBundle,
} = require('../lib/workbench/receipt-bundle-exporter');
const { ROUTE_PATH } = require('../lib/workbench/receipt-bundle-export-route');
const { verifyExportedBundle } = require('../lib/receipt/receipt-export');
const { exportMaterializedReceiptBundle } = require('../lib/receipt/receipt-read-index');
const { listAuthenticatedRouteIds } = require('../lib/http/route-auth-policy');
const packageManifest = require('../package.json');

// --- helpers -------------------------------------------------------------

function rawReceipt(index, overrides = {}) {
  return {
    receiptId: `rcpt-v4-b3-${String(index).padStart(6, '0')}`,
    receiptKind: 'admission',
    decision: 'allow',
    status: 'admitted',
    admissionId: `adm-v4-b3-${index}`,
    workspaceId: CANONICAL_WORKSPACE_ID,
    provenanceId: `prov-v4-b3-${index}`,
    trustPolicyVersion: '1.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function auditEvent(receipt, index) {
  return {
    auditId: `audit-v4-b3-${index}`,
    eventType: 'LEARN',
    targetType: 'edge',
    targetId: `edge-${index}`,
    workspaceId: receipt.workspaceId || CANONICAL_WORKSPACE_ID,
    timestamp: '2026-01-01T00:00:00.000Z',
    details: { receipt },
  };
}

function auditOwnerOf(receipts) {
  const events = receipts.map((receipt, index) => auditEvent(receipt, index));
  return {
    getAuditEvents(filters = {}) {
      if (!filters.workspaceId) return events;
      return events.filter((event) => event.workspaceId === filters.workspaceId);
    },
  };
}

function request(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: opts.method || 'GET',
      headers: opts.auth === false
        ? {}
        : { Authorization: `Bearer ${process.env.AXIOM_API_KEY}` },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch (_error) {
          body = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, body, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function assertBoundedHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

function assertNoLeakage(response) {
  assert.equal(typeof response.text, 'string');
  assert.doesNotMatch(response.text, /\n\s*at\s|stack|Traceback/i);
  assert.doesNotMatch(response.text, /TypeError|ReferenceError|SQLITE_|_auditEvents/);
}

function seedReceipt(text, workspaceId) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const result = server.kernel.learn(text, {
    workspaceId,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr-v4-b3-${suffix}`,
    provenance: {
      provenanceId: `prov-v4-b3-${suffix}`,
      sourceType: 'test',
      sourceRef: 'test:v4-b3-receipt-bundle-export',
      actor: 'v4-b3-acceptance-test',
      workspaceId,
      timestamp: new Date().toISOString(),
      trustPolicyVersion: '1.0.0',
    },
  });
  assert.equal(result.data?.admission?.outcome, 'allow');
  return result.data.admission.receipt;
}

// --- owner-level adversarial evidence ------------------------------------

describe('V4-B3 owner: canonical workspace boundary', () => {
  const owner = auditOwnerOf([rawReceipt(1)]);

  it('treats an omitted workspace as canonical default', () => {
    const result = exportWorkbenchReceiptBundle({ auditOwner: owner });
    assert.equal(result.ok, true);
    assert.equal(result.bundle.workspaceId, CANONICAL_WORKSPACE_ID);
  });

  it('accepts the exact string default', () => {
    const result = exportWorkbenchReceiptBundle({ auditOwner: owner, workspaceId: 'default' });
    assert.equal(result.ok, true);
  });

  it('fails closed for every non-default workspace form before any read', () => {
    let reads = 0;
    const trippingOwner = {
      getAuditEvents() {
        reads += 1;
        return [];
      },
    };
    const rejected = [
      ' default', 'default ', '\tdefault', 'default\n', 'DEFAULT', 'Default',
      '', ' ', 'other', 'default/../other', 0, 1, true, false, [], ['default'],
      {}, { workspaceId: 'default' }, Number.NaN,
    ];

    for (const value of rejected) {
      const result = exportWorkbenchReceiptBundle({ auditOwner: trippingOwner, workspaceId: value });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(value)}`);
      assert.equal(result.status, 'invalid_request', `wrong status for ${JSON.stringify(value)}`);
      assert.equal(result.error.code, 'invalid_workspace_id');
      assert.equal(result.bundle, undefined);
    }
    assert.equal(reads, 0, 'no read may happen for a non-default workspace');
  });
});

describe('V4-B3 owner: empty result is a truthful state', () => {
  it('returns a verified empty bundle rather than not_found', () => {
    const result = exportWorkbenchReceiptBundle({ auditOwner: auditOwnerOf([]) });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'exported');
    assert.deepEqual(result.bundle.receipts, []);
    assert.equal(result.bundle.receiptCount, 0);
    assert.equal(verifyExportedBundle(result.bundle).valid, true);
  });
});

describe('V4-B3 owner: receipt count ceiling', () => {
  it('fails closed before cloning, chain expansion or serialization', () => {
    let deepReads = 0;
    const receipts = [];
    for (let i = 0; i < MAX_RECEIPTS + 1; i++) {
      const receipt = rawReceipt(i);
      // JSON.stringify enumerates this getter, so any deep clone, chain build
      // or serialization of the receipt trips it. The guard reads only
      // receiptId, so a fail-closed rejection must leave it at zero.
      Object.defineProperty(receipt, 'cloneTripwire', {
        enumerable: true,
        get() {
          deepReads += 1;
          return 'tripped';
        },
      });
      receipts.push(receipt);
    }

    const result = exportWorkbenchReceiptBundle({ auditOwner: auditOwnerOf(receipts) });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'ceiling_exceeded');
    assert.equal(result.error.code, 'receipt_count_ceiling_exceeded');
    assert.equal(result.bundle, undefined, 'no partial bundle');
    assert.equal(deepReads, 0, 'no receipt may be cloned, chained or serialized');
  });

  it('admits exactly MAX_RECEIPTS distinct receipts', () => {
    const receipts = [];
    for (let i = 0; i < MAX_RECEIPTS; i++) receipts.push(rawReceipt(i));
    const result = exportWorkbenchReceiptBundle({ auditOwner: auditOwnerOf(receipts) });
    assert.equal(result.ok, true);
    assert.equal(result.bundle.receiptCount, MAX_RECEIPTS);
  });
});

describe('V4-B3 owner: serialized byte ceiling', () => {
  it('fails closed on actual serialized UTF-8 bytes with no partial bundle', () => {
    const padding = 'x'.repeat(4096);
    const receipts = [];
    for (let i = 0; i < 700; i++) {
      receipts.push(rawReceipt(i, { metadata: { padding, index: i } }));
    }

    const result = exportWorkbenchReceiptBundle({ auditOwner: auditOwnerOf(receipts) });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'ceiling_exceeded');
    assert.equal(result.error.code, 'receipt_bundle_byte_ceiling_exceeded');
    assert.equal(result.bundle, undefined, 'no partial or truncated bundle');

    // The rejection is driven by real serialized size, not by receipt count:
    // 700 receipts is well under MAX_RECEIPTS.
    assert.ok(receipts.length < MAX_RECEIPTS);
    const sourceBundle = exportMaterializedReceiptBundle(auditOwnerOf(receipts), {
      workspaceId: CANONICAL_WORKSPACE_ID,
    });
    const actualBytes = Buffer.byteLength(JSON.stringify(sourceBundle.bundle), 'utf8');
    assert.ok(
      actualBytes > MAX_SERIALIZED_BUNDLE_BYTES,
      `expected over ${MAX_SERIALIZED_BUNDLE_BYTES} bytes, measured ${actualBytes}`,
    );
  });

  it('admits a bundle that stays within the byte ceiling', () => {
    const receipts = [rawReceipt(1, { metadata: { padding: 'x'.repeat(1024) } })];
    const result = exportWorkbenchReceiptBundle({ auditOwner: auditOwnerOf(receipts) });
    assert.equal(result.ok, true);
    assert.ok(result.serializedBytes <= MAX_SERIALIZED_BUNDLE_BYTES);
  });
});

describe('V4-B3 owner: chain and verification gates', () => {
  it('returns invalid_chain with no bundle for a broken materialized receipt', () => {
    const broken = rawReceipt(1);
    delete broken.provenanceId;
    const result = exportWorkbenchReceiptBundle({ auditOwner: auditOwnerOf([rawReceipt(0), broken]) });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid_chain');
    assert.equal(result.error.code, 'receipt_chain_invalid');
    assert.equal(result.bundle, undefined);
    assert.equal(result.error.message, undefined, 'no internal message may leak');
  });

  /**
   * EVIDENCE GAP, recorded rather than hidden.
   *
   * Task-pack acceptance item 6 asks for the verification gate to be proved by
   * forcing `verifyExportedBundle()` to fail. That cannot be done from inside
   * the authorized scope: `exportReceiptBundle()` derives the bundle hash, the
   * bundle schema version and the chain validation from the very same receipts
   * array that `verifyExportedBundle()` then recomputes them from, and it
   * already runs `validateV4Chain()` before returning. A freshly exported
   * bundle is therefore verifiable by construction, and forcing a failure would
   * require changing `lib/receipt/*`, which this scope forbids.
   *
   * Attempted and rejected as fake evidence: a live getter on the raw receipt
   * does not survive `collectMaterializedReceiptEntries()`, which deep-clones
   * through JSON before the payload is built, so it produces a stable value
   * rather than a verification failure.
   *
   * What is proved instead: the verifier really does reject tampering (below),
   * and the owner returns no bundle on any non-ok outcome (property test here).
   * The gate remains defense in depth against a future change to the export
   * primitives.
   */
  it('never returns a bundle that does not verify', () => {
    const cases = [
      [rawReceipt(1)],
      [],
      [rawReceipt(1), rawReceipt(2)],
      [rawReceipt(1), rawReceipt(1)],
      [rawReceipt(1, { metadata: { nested: { deep: [1, 2, 3] } } })],
      [rawReceipt(1, { canonicalReceiptSchemaVersion: 'not-a-real-version' })],
      [rawReceipt(1, { decision: 'not-a-verdict' })],
      [rawReceipt(1, { riskScore: Number.NaN })],
    ];

    for (const receipts of cases) {
      const result = exportWorkbenchReceiptBundle({ auditOwner: auditOwnerOf(receipts) });
      if (result.ok === true) {
        assert.equal(
          verifyExportedBundle(result.bundle).valid,
          true,
          'a returned bundle must always verify',
        );
      } else {
        assert.equal(result.bundle, undefined, 'a rejected export must carry no bundle');
        assert.equal(result.error.message, undefined, 'no internal message may leak');
      }
    }
  });

  it('maps a verification failure to 409 with no bundle body', () => {
    const { STATUS_TO_HTTP } = require('../lib/workbench/receipt-bundle-export-route');
    assert.equal(STATUS_TO_HTTP.verification_failed, 409);
    assert.equal(STATUS_TO_HTTP.invalid_chain, 409);
    assert.equal(STATUS_TO_HTTP.ceiling_exceeded, 413);
  });

  it('rejects a bundle whose receipts were tampered with after export', () => {
    const source = exportMaterializedReceiptBundle(auditOwnerOf([rawReceipt(1)]), {
      workspaceId: CANONICAL_WORKSPACE_ID,
    });
    assert.equal(verifyExportedBundle(source.bundle).valid, true);

    const tampered = JSON.parse(JSON.stringify(source.bundle));
    tampered.receipts[0].reason = 'tampered-after-export';
    assert.equal(verifyExportedBundle(tampered).valid, false);
  });
});

describe('V4-B3 owner: read failures stay bounded', () => {
  it('maps a throwing audit owner to read_error without leaking the cause', () => {
    const result = exportWorkbenchReceiptBundle({
      auditOwner: {
        getAuditEvents() {
          throw new Error('SQLITE_IOERR: private storage detail');
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'read_error');
    assert.equal(result.error.code, 'receipt_bundle_read_failed');
    assert.equal(JSON.stringify(result).includes('SQLITE_IOERR'), false);
  });

  it('maps a malformed audit result to read_error', () => {
    const result = exportWorkbenchReceiptBundle({ auditOwner: { getAuditEvents: () => 'nope' } });
    assert.equal(result.status, 'read_error');
  });

  it('maps a missing audit owner to read_error', () => {
    assert.equal(exportWorkbenchReceiptBundle({}).status, 'read_error');
  });
});

// --- declaration and packaging evidence ----------------------------------

describe('V4-B3 surface declaration', () => {
  it('declares the route in the central auth policy', () => {
    assert.ok(listAuthenticatedRouteIds().includes('workbench-receipt-bundle'));
  });

  it('ships both new runtime modules in the package files allowlist', () => {
    assert.ok(packageManifest.files.includes('lib/workbench/receipt-bundle-exporter.js'));
    assert.ok(packageManifest.files.includes('lib/workbench/receipt-bundle-export-route.js'));
  });

  it('adds no CLI, MCP or UI surface', () => {
    const repoRoot = path.join(__dirname, '..');
    for (const file of ['cli.js', 'server.js']) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      assert.equal(source.includes('receipt-bundle'), false, `${file} must not gain a receipt-bundle surface`);
    }
  });
});

// --- real server acceptance ----------------------------------------------

describe('V4-B3 acceptance: real server, Kernel, SQLite Graph, loopback HTTP', () => {
  let port;

  before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    server.closeAxiom();
  });

  it('returns 200 with an empty verified bundle before anything is seeded', async () => {
    const response = await request(port, ROUTE_PATH);
    assert.equal(response.status, 200, 'absence of receipts is not a missing resource');
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.bundle.receipts, []);
    assert.equal(verifyExportedBundle(response.body.bundle).valid, true);
    assertBoundedHeaders(response);
  });

  it('returns a verified bundle for the default workspace, omitted and explicit', async () => {
    seedReceipt('kirlangic kustur', CANONICAL_WORKSPACE_ID);
    seedReceipt('bulbul kustur', CANONICAL_WORKSPACE_ID);

    const omitted = await request(port, ROUTE_PATH);
    assert.equal(omitted.status, 200);
    assert.equal(omitted.body.status, 'exported');
    assert.ok(omitted.body.bundle.receiptCount >= 2);
    assert.equal(verifyExportedBundle(omitted.body.bundle).valid, true);
    assertBoundedHeaders(omitted);

    const explicit = await request(port, `${ROUTE_PATH}?workspaceId=default`);
    assert.equal(explicit.status, 200);
    assert.equal(verifyExportedBundle(explicit.body.bundle).valid, true);
    assert.equal(explicit.body.bundle.bundleHash, omitted.body.bundle.bundleHash);
  });

  it('returns the unredacted source bundle with no field stripped or reshaped', async () => {
    const response = await request(port, ROUTE_PATH);
    const source = exportMaterializedReceiptBundle(server.kernel.graph, {
      workspaceId: CANONICAL_WORKSPACE_ID,
    });

    assert.equal(
      JSON.stringify(response.body.bundle.receipts),
      JSON.stringify(source.bundle.receipts),
      'receipts must be byte-identical to the unredacted source bundle',
    );
    assert.equal(response.body.bundle.bundleHash, source.bundle.bundleHash);
    assert.equal(response.body.bundle.schemaVersion, source.bundle.schemaVersion);
  });

  it('denies an unauthenticated request', async () => {
    const response = await request(port, ROUTE_PATH, { auth: false });
    assert.equal(response.status, 401);
    assert.equal(response.body?.bundle, undefined);
  });

  it('keeps an undeclared neighbouring path a 404 rather than a 401', async () => {
    const authed = await request(port, `${ROUTE_PATH}-neighbour`);
    assert.equal(authed.status, 404);
    const anonymous = await request(port, `${ROUTE_PATH}-neighbour`, { auth: false });
    assert.equal(anonymous.status, 404, 'an undeclared path must not leak its absence through 401');
  });

  it('fails closed with 400 and bounded headers for non-default workspaces', async () => {
    for (const query of ['%20default', 'DEFAULT', '', 'other', 'default%20', 'default&workspaceId=default']) {
      const response = await request(port, `${ROUTE_PATH}?workspaceId=${query}`);
      assert.equal(response.status, 400, `expected 400 for workspaceId=${query}`);
      assert.equal(response.body.status, 'invalid_request');
      assert.equal(response.body.bundle, undefined);
      assertBoundedHeaders(response);
      assertNoLeakage(response);
    }
  });

  it('rejects a non-GET method with bounded headers', async () => {
    const response = await request(port, ROUTE_PATH, { method: 'POST' });
    assert.equal(response.status, 405);
    assertBoundedHeaders(response);
  });

  it('leaks no raw exception, stack or private Graph row on success', async () => {
    const response = await request(port, ROUTE_PATH);
    assertNoLeakage(response);
    assert.equal(response.text.includes('_auditEvents'), false);
  });
});
