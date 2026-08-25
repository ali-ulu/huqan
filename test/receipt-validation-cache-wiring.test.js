'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReceiptValidationCache } = require('../lib/receipt/receipt-validation-cache');
const { getReceiptStamp } = require('../lib/receipt/receipt-stamp');
const { inspectTrustReceipt } = require('../lib/workbench/trust-receipt-inspector');
const { GENESIS_PREVIOUS_HASH } = require('../lib/receipt/receipt-chain');

const HEAD_HASH = 'a'.repeat(64);

function sourceWithStamp(state) {
  return {
    id: 'cache-wiring-source',
    getReceiptFamilyById() {
      return 'v4';
    },
    getReceiptStamp() {
      return state;
    },
  };
}

function foundRead(receiptId, calls) {
  return () => {
    calls.count += 1;
    return {
      ok: true,
      status: 'found',
      receiptId,
      receipt: {
        receiptId,
        workspaceId: 'workspace-a',
        decision: 'allow',
        actor: 'agent-a',
        reason: 'verified',
        metadata: {},
      },
      canonicalPayload: {
        workspaceId: 'workspace-a',
        verdict: 'allow',
        actor: 'agent-a',
        reason: 'verified',
        createdAt: '2026-08-19T00:00:00.000Z',
      },
      chainedReceipt: { receiptId, receiptHash: HEAD_HASH },
      auditEvent: { timestamp: '2026-08-19T00:00:00.000Z' },
      chainStatus: { valid: true },
      chainValidation: { valid: true },
    };
  };
}

test('inspector reuses a validated found result only for an exact stamp', () => {
  const state = {
    generation: 1,
    receiptCount: 1,
    headHash: HEAD_HASH,
  };
  const source = sourceWithStamp(state);
  const cache = createReceiptValidationCache();
  const calls = { count: 0 };
  const options = {
    receiptId: 'receipt-cache-hit',
    workspaceId: 'workspace-a',
    schemaFamily: 'v4',
    source,
    cache,
    readReceipt: foundRead('receipt-cache-hit', calls),
  };

  const first = inspectTrustReceipt(options);
  const second = inspectTrustReceipt(options);

  assert.equal(first.status, 'found');
  assert.deepEqual(second, first);
  assert.equal(calls.count, 1);
  assert.equal(cache.stats().hits, 1);
});

test('different receipt ids use independent validation cache entries', () => {
  const state = {
    generation: 1,
    receiptCount: 2,
    headHash: HEAD_HASH,
  };
  const source = sourceWithStamp(state);
  const cache = createReceiptValidationCache();
  const calls = { count: 0 };
  const inspect = (receiptId) => inspectTrustReceipt({
    receiptId,
    workspaceId: 'workspace-a',
    schemaFamily: 'v4',
    source,
    cache,
    readReceipt: foundRead(receiptId, calls),
  });

  assert.equal(inspect('receipt-a').status, 'found');
  assert.equal(inspect('receipt-b').status, 'found');
  assert.equal(inspect('receipt-a').status, 'found');
  assert.equal(inspect('receipt-b').status, 'found');

  assert.equal(calls.count, 2);
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().hits, 2);
  assert.equal(cache.stats().misses, 2);
});

test('inspector treats a changed generation as a cache miss', () => {
  const state = {
    generation: 1,
    receiptCount: 1,
    headHash: HEAD_HASH,
  };
  const source = sourceWithStamp(state);
  const cache = createReceiptValidationCache();
  const calls = { count: 0 };
  const options = {
    receiptId: 'receipt-stale-stamp',
    workspaceId: 'workspace-a',
    schemaFamily: 'v4',
    source,
    cache,
    readReceipt: foundRead('receipt-stale-stamp', calls),
  };

  inspectTrustReceipt(options);
  state.generation = 2;
  inspectTrustReceipt(options);

  assert.equal(calls.count, 2);
  assert.equal(cache.stats().hits, 0);
  assert.equal(cache.stats().entries, 2);
});

test('inspector memoizes chain_invalid without promoting it to found', () => {
  const state = {
    generation: 3,
    receiptCount: 1,
    headHash: HEAD_HASH,
  };
  const source = sourceWithStamp(state);
  const cache = createReceiptValidationCache();
  const calls = { count: 0 };
  const readReceipt = () => {
    calls.count += 1;
    return {
      ok: false,
      status: 'chain_invalid',
      receiptId: 'receipt-broken',
    };
  };
  const options = {
    receiptId: 'receipt-broken',
    workspaceId: 'workspace-a',
    schemaFamily: 'v4',
    source,
    cache,
    readReceipt,
  };

  const first = inspectTrustReceipt(options);
  const second = inspectTrustReceipt(options);

  assert.equal(first.status, 'chain_invalid');
  assert.equal(second.status, 'chain_invalid');
  assert.equal(second.ok, false);
  assert.equal(calls.count, 1);
  assert.equal(cache.stats().hits, 1);
});

test('inspector bypasses caching when the source has no authoritative stamp', () => {
  const cache = createReceiptValidationCache();
  const calls = { count: 0 };
  const source = [{ id: 'array-source' }];
  const options = {
    receiptId: 'receipt-array',
    workspaceId: 'workspace-a',
    source,
    cache,
    readReceipt: foundRead('receipt-array', calls),
  };

  inspectTrustReceipt(options);
  inspectTrustReceipt(options);

  assert.equal(calls.count, 2);
  assert.deepEqual(cache.stats(), {
    entries: 0,
    bytes: 0,
    maxEntries: 256,
    maxBytes: 4 * 1024 * 1024,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
});

test('Graph-style empty stamp remains valid only for an empty genesis chain', () => {
  const cache = createReceiptValidationCache();
  const source = sourceWithStamp({
    generation: 0,
    receiptCount: 0,
    headHash: GENESIS_PREVIOUS_HASH,
  });
  const calls = { count: 0 };
  const options = {
    receiptId: 'receipt-empty',
    workspaceId: 'workspace-a',
    schemaFamily: 'v4',
    source,
    cache,
    readReceipt: () => {
      calls.count += 1;
      return { ok: false, status: 'not_found', receiptId: 'receipt-empty' };
    },
  };

  inspectTrustReceipt(options);
  inspectTrustReceipt(options);

  assert.equal(calls.count, 2, 'not_found results are not cached');
  assert.equal(cache.stats().entries, 0);
});


test('receipt stamp utility follows materialized audit receipts and invalidates after a new head', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Graph = require('../graph');
  const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-receipt-stamp-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    useSQLite: false,
  });
  const makePayload = (receiptId, createdAt) => buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `admission-${receiptId}`,
    workspaceId: 'workspace-a',
    provenanceId: `prov-${receiptId}`,
    trustPolicyVersion: 'test',
    createdAt,
  }, { verdict: 'allow' });
  const materialize = (committed) => graph.appendAuditEvent({
    eventType: 'TRUST_RECEIPT_MATERIALIZED',
    targetType: 'trust_receipt',
    targetId: committed.receipt.receiptId,
    workspaceId: 'workspace-a',
    timestamp: committed.receipt.canonicalPayload.createdAt,
    details: {
      // Materialization stores the canonical payload; chain fields remain in
      // the durable mutation journal and must not be manufactured by the test.
      receipt: committed.receipt.canonicalPayload,
    },
  }, { workspaceId: 'workspace-a' });

  try {
    const firstCommitted = graph.runMutationOnce('stamp-operation-1', () => ({ ok: true }), {
      buildCanonicalReceipt: () => makePayload('stamp-receipt-1', '2026-01-01T00:00:00.000Z'),
    });
    materialize(firstCommitted);
    const firstStamp = getReceiptStamp(graph, 'workspace-a', 'v4');

    assert.deepEqual(firstStamp, {
      generation: 1,
      receiptCount: 1,
      headHash: firstCommitted.receipt.receiptHash,
    });

    const cache = createReceiptValidationCache();
    const options = {
      receiptId: 'stamp-receipt-1',
      workspaceId: 'workspace-a',
      source: graph,
      cache,
    };
    assert.equal(inspectTrustReceipt(options).status, 'found');
    assert.equal(inspectTrustReceipt(options).status, 'found');
    assert.equal(cache.stats().hits, 1);

    const secondCommitted = graph.runMutationOnce('stamp-operation-2', () => ({ ok: true }), {
      buildCanonicalReceipt: () => makePayload('stamp-receipt-2', '2026-01-01T00:01:00.000Z'),
    });
    materialize(secondCommitted);
    const secondStamp = getReceiptStamp(graph, 'workspace-a', 'v4');

    assert.deepEqual(secondStamp, {
      generation: 2,
      receiptCount: 2,
      headHash: secondCommitted.receipt.receiptHash,
    });
    assert.equal(inspectTrustReceipt(options).status, 'found');
    assert.equal(cache.stats().hits, 1, 'a new materialized head must force a validation miss');
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('receipt stamp uses the durable SQLite receipt when materialization omits chain fields', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Graph = require('../graph');
  const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-receipt-stamp-sqlite-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  });
  const receipt = buildCanonicalReceiptPayload({
    receiptId: 'sqlite-stamp-receipt-1',
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: 'sqlite-stamp-admission-1',
    workspaceId: 'workspace-a',
    provenanceId: 'sqlite-stamp-provenance-1',
    trustPolicyVersion: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
  }, { verdict: 'allow' });

  try {
    const committed = graph.runMutationOnce('sqlite-stamp-operation-1', () => ({ ok: true }), {
      buildCanonicalReceipt: () => receipt,
    });
    graph.appendAuditEvent({
      eventType: 'TRUST_RECEIPT_MATERIALIZED',
      targetType: 'trust_receipt',
      targetId: receipt.receiptId,
      workspaceId: 'workspace-a',
      timestamp: receipt.createdAt,
      details: { receipt },
    }, { workspaceId: 'workspace-a' });

    assert.equal(receipt.receiptHash, undefined);
    assert.deepEqual(getReceiptStamp(graph, 'workspace-a', 'v4'), {
      generation: 1,
      receiptCount: 1,
      headHash: committed.receipt.receiptHash,
    });

    const cache = createReceiptValidationCache();
    const options = {
      receiptId: receipt.receiptId,
      workspaceId: 'workspace-a',
      source: graph,
      cache,
    };
    assert.equal(inspectTrustReceipt(options).status, 'found');
    assert.equal(inspectTrustReceipt(options).status, 'found');
    assert.equal(cache.stats().hits, 1);
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workbench router keeps one cache instance across receipt requests', () => {
  const { createWorkbenchReadHttpRouter } = require('../lib/workbench/workbench-read-http-router');
  const cache = createReceiptValidationCache();
  const state = { generation: 1, receiptCount: 1, headHash: HEAD_HASH };
  const graph = sourceWithStamp(state);
  const calls = { count: 0 };
  const bodies = [];
  const router = createWorkbenchReadHttpRouter({
    writeJson(_req, _res, _statusCode, body) {
      bodies.push(body);
    },
    writeApiError() {},
    denyIfUnauthorized() {
      return true;
    },
    readTrustFilters() {
      return {};
    },
    readReceiptById: foundRead('router-receipt', calls),
    receiptValidationCache: cache,
  });
  const request = { method: 'GET' };
  const response = { setHeader() {} };
  const requestUrl = new URL('http://localhost/api/workbench/trust-receipt/router-receipt?workspaceId=workspace-a');

  assert.equal(router(request, response, requestUrl, graph), true);
  assert.equal(router(request, response, requestUrl, graph), true);
  assert.equal(calls.count, 1);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].status, 'found');
  assert.equal(bodies[1].status, 'found');
  assert.equal(cache.stats().hits, 1);
});
