const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');
const { createMemoryContextAuditSource } = require('../lib/workbench/memory-context-audit-source');
const { inspectTrustReceipt, PUBLIC_REASONS } = require('../lib/workbench/trust-receipt-inspector');
const { createWorkbenchReadHttpRouter } = require('../lib/workbench/workbench-read-http-router');

const SECRET = '/var/secrets/huqan-driver.key';

let tempDir;
let counter = 0;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-workbench-'));
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeGraph() {
  return new Graph({
    memoryPath: path.join(tempDir, `wb-${counter++}.json`),
    useSQLite: true,
    noLoad: true,
  });
}

function seedAudit(graph, count, workspaceId = 'workspace-alpha') {
  let last = null;
  for (let i = 0; i < count; i++) {
    last = graph.appendAuditEvent({
      eventType: 'LEARN',
      targetType: 'edge',
      targetId: `edge-${i}`,
      workspaceId,
      details: { admissionOutcome: 'allow', receipt: { decision: 'allow', canonical: true } },
    });
  }
  return last;
}

describe('Workbench memory-context lookup is bounded (#736)', () => {
  it('an exact lookup does not materialize the workspace history', () => {
    const graph = makeGraph();
    const target = seedAudit(graph, 600);

    let materialized = 0;
    const originalAll = graph._stmts.allAuditEvents.all.bind(graph._stmts.allAuditEvents);
    graph._stmts.allAuditEvents.all = (...args) => {
      materialized += 1;
      return originalAll(...args);
    };

    try {
      const source = createMemoryContextAuditSource(graph);
      const context = source.readMemoryContext({
        recordId: target.auditId,
        workspaceId: 'workspace-alpha',
      });
      assert.ok(context, 'the exact record should still be found');
      assert.strictEqual(context.recordId, target.auditId);
      assert.strictEqual(materialized, 0, 'an exact lookup must not read every audit row');
    } finally {
      graph._stmts.allAuditEvents.all = originalAll;
    }
  });

  it('reads at most two rows, which is all an exact lookup needs', () => {
    const graph = makeGraph();
    const target = seedAudit(graph, 300);

    const seen = [];
    const wrapped = {
      getAuditEvents: (filters) => graph.getAuditEvents(filters),
      queryAuditEvents: (options) => {
        seen.push(options);
        return graph.queryAuditEvents(options);
      },
    };

    const source = createMemoryContextAuditSource(wrapped);
    assert.ok(source.readMemoryContext({ recordId: target.auditId, workspaceId: 'workspace-alpha' }));
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].limit, 2);
    assert.strictEqual(seen[0].filters.auditId, target.auditId);
    assert.strictEqual(seen[0].filters.workspaceId, 'workspace-alpha');
  });

  it('a miss is still a miss, and other workspaces stay invisible', () => {
    const graph = makeGraph();
    const target = seedAudit(graph, 5, 'workspace-alpha');
    seedAudit(graph, 5, 'workspace-beta');
    const source = createMemoryContextAuditSource(graph);

    assert.strictEqual(source.readMemoryContext({ recordId: 'nope', workspaceId: 'workspace-alpha' }), null);
    assert.strictEqual(
      source.readMemoryContext({ recordId: target.auditId, workspaceId: 'workspace-beta' }),
      null,
      'a record must not be readable from another workspace',
    );
  });

  it('duplicate authoritative identifiers still fail closed', () => {
    const duplicate = {
      auditId: 'dup-1',
      workspaceId: 'workspace-alpha',
      details: { admissionOutcome: 'allow' },
    };
    const owner = {
      getAuditEvents: () => [duplicate, duplicate],
      queryAuditEvents: () => ({ items: [duplicate, duplicate], hasMore: false, nextCursor: null, limit: 2 }),
    };
    const source = createMemoryContextAuditSource(owner);
    assert.throws(
      () => source.readMemoryContext({ recordId: 'dup-1', workspaceId: 'workspace-alpha' }),
      (error) => error.code === 'AMBIGUOUS_AUDIT_EVENT',
    );
  });

  it('an owner without the bounded primitive still answers, with the filter pushed down', () => {
    const graph = makeGraph();
    const target = seedAudit(graph, 20);
    const legacyOwner = { getAuditEvents: (filters) => graph.getAuditEvents(filters) };
    const source = createMemoryContextAuditSource(legacyOwner);
    const context = source.readMemoryContext({
      recordId: target.auditId,
      workspaceId: 'workspace-alpha',
    });
    assert.ok(context);
    assert.strictEqual(context.recordId, target.auditId);
  });
});

describe('Workbench trust-receipt errors expose no internals (#737)', () => {
  it('a thrown read error does not reach the response', () => {
    const inspection = inspectTrustReceipt({
      receiptId: 'receipt-1',
      source: {},
      readReceipt: () => { throw new Error(`sqlite driver failed opening ${SECRET}`); },
    });
    assert.strictEqual(inspection.ok, false);
    assert.strictEqual(inspection.status, 'read_error');
    assert.strictEqual(inspection.reason, PUBLIC_REASONS.RECEIPT_READ_FAILED);
    assert.ok(!JSON.stringify(inspection).includes(SECRET), 'response leaked the internal error text');
    assert.ok(!JSON.stringify(inspection).includes('sqlite'), 'response leaked driver detail');
  });

  it('a failed read result is not echoed either', () => {
    const inspection = inspectTrustReceipt({
      receiptId: 'receipt-1',
      source: {},
      readReceipt: () => ({ ok: false, status: 'read_error', error: { message: `schema violation at ${SECRET}` } }),
    });
    assert.strictEqual(inspection.reason, PUBLIC_REASONS.RECEIPT_READ_FAILED);
    assert.ok(!JSON.stringify(inspection).includes(SECRET));
    assert.ok(!JSON.stringify(inspection).includes('schema violation'));
  });

  it('every reason is one of the declared public values', () => {
    const allowed = new Set(Object.values(PUBLIC_REASONS));
    const cases = [
      inspectTrustReceipt({}),
      inspectTrustReceipt({ receiptId: 'r' }),
      inspectTrustReceipt({ receiptId: 'r', source: {}, readReceipt: () => null }),
      inspectTrustReceipt({ receiptId: 'r', source: {}, readReceipt: () => ({ ok: false, status: 'not_found' }) }),
      inspectTrustReceipt({ receiptId: 'r', source: {}, readReceipt: () => ({ ok: false, status: 'invalid_request' }) }),
      inspectTrustReceipt({ receiptId: 'r', source: {}, readReceipt: () => { throw new Error('boom'); } }),
    ];
    for (const inspection of cases) {
      assert.ok(allowed.has(inspection.reason), `unexpected public reason: ${inspection.reason}`);
    }
  });

  it('the distinct public states are preserved', () => {
    assert.strictEqual(inspectTrustReceipt({}).status, 'invalid_request');
    assert.strictEqual(inspectTrustReceipt({ receiptId: 'r' }).status, 'read_error');
    assert.strictEqual(
      inspectTrustReceipt({ receiptId: 'r', source: {}, readReceipt: () => ({ ok: false, status: 'not_found' }) }).status,
      'not_found',
    );
  });
});

describe('Workbench read responses are not cacheable (#738, #768)', () => {
  function captureRoute({ pathname, method = 'GET', search = '?workspaceId=default', readReceipt }) {
    const captured = [];
    const router = createWorkbenchReadHttpRouter({
      writeJson: (req, res, statusCode, body, headers) => captured.push({ statusCode, body, headers }),
      writeApiError: (req, res, statusCode, code, message) => captured.push({ statusCode, code, message, headers: {} }),
      denyIfUnauthorized: () => true,
      readTrustFilters: () => ({}),
      readReceipt: () => null,
      readReceiptById: readReceipt || (() => ({ ok: false, status: 'not_found' })),
    });
    const reqUrl = new URL(`http://localhost${pathname}${search}`);
    // A graph stand-in that satisfies the memory-context audit-owner contract.
    const graph = { getAuditEvents: () => [], queryAuditEvents: () => ({ items: [], hasMore: false, nextCursor: null, limit: 2 }) };
    router({ method }, { setHeader() {} }, reqUrl, graph);
    return captured;
  }

  const paths = [
    '/api/workbench/trust-receipt/receipt-1',
    '/api/workbench/memory-context/record-1',
  ];

  for (const pathname of paths) {
    it(`${pathname} answers with no-store and nosniff`, () => {
      for (const captured of [
        captureRoute({ pathname }),
        captureRoute({ pathname, method: 'POST' }),
        captureRoute({ pathname, search: '?workspaceId=a&workspaceId=b' }),
      ]) {
        assert.ok(captured.length > 0, `${pathname}: no response captured`);
        for (const { headers } of captured) {
          assert.strictEqual(headers['Cache-Control'], 'no-store',
            `${pathname}: no-cache permits storage, so it must not be used here`);
          assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff');
        }
      }
    });
  }

  it('a successful trust-receipt read is also no-store', () => {
    const captured = captureRoute({
      pathname: '/api/workbench/trust-receipt/receipt-1',
      readReceipt: () => ({
        ok: true,
        receiptId: 'receipt-1',
        receipt: { receiptId: 'receipt-1', workspaceId: 'default', metadata: {} },
        canonicalPayload: { workspaceId: 'default', verdict: 'allow' },
        chainedReceipt: {},
        auditEvent: {},
        chainStatus: 'valid',
        chainValidation: { valid: true },
      }),
    });
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].statusCode, 200);
    assert.strictEqual(captured[0].headers['Cache-Control'], 'no-store');
  });
});
