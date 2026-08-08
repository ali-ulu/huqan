'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Graph = require('../graph');
const {
  AUDIT_EVENT_DETAILS_LIMIT_CODE,
  AUDIT_EVENT_SOURCE_DIVERGENCE_CODE,
  iterateAuditEventsBounded,
} = require('../lib/audit-bounded-read');
const {
  CIRCULAR_REFERENCE_CODE,
  SIZE_LIMIT_CODE,
  UNSUPPORTED_VALUE_CODE,
  measureJsonUtf8Bytes,
} = require('../lib/json-utf8-size');
const {
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  exportMaterializedReceiptBundleBounded,
} = require('../lib/receipt/bounded-receipt-export');
const {
  buildMaterializedReceiptChain,
  exportMaterializedReceiptBundle,
  receiptToCanonicalPayload,
} = require('../lib/receipt/receipt-read-index');
const { exportReceiptBundle, verifyExportedBundle } = require('../lib/receipt/receipt-export');

const BASE_TIME = Date.parse('2026-08-08T00:00:00.000Z');

function receipt(index, overrides = {}) {
  return {
    receiptId: overrides.receiptId || `receipt-b3a-${index}`,
    receiptKind: 'memory_admission',
    decision: overrides.decision || 'allow',
    status: 'accepted',
    admissionId: `admission-b3a-${index}`,
    workspaceId: overrides.workspaceId || 'default',
    actor: 'b3a-test',
    agentId: 'agent-b3a',
    memoryDraftId: `draft-b3a-${index}`,
    provenanceId: `prov-b3a-${index}`,
    trustPolicyVersion: 'b3a-test-v1',
    approvalId: '',
    approvalStatus: '',
    reason: 'accepted',
    riskScore: 0,
    createdAt: new Date(BASE_TIME + index * 1000).toISOString(),
    metadata: overrides.metadata || {},
    ...(overrides.v2 ? {
      canonicalReceiptSchemaVersion: 'v4-receipt-v2',
      trustRoot: overrides.trustRoot || 'local_operator',
    } : {}),
  };
}

function auditEvent(index, rawReceipt, overrides = {}) {
  const workspaceId = overrides.workspaceId || rawReceipt?.workspaceId || 'default';
  return {
    auditId: overrides.auditId || `audit-b3a-${index}`,
    eventType: 'LEARN',
    targetType: 'edge',
    targetId: `a-${index}|is_a|b-${index}`,
    workspaceId,
    actor: 'b3a-test',
    timestamp: new Date(BASE_TIME + index * 1000).toISOString(),
    sourceRef: 'test:v4-b3a',
    provenanceId: `prov-audit-b3a-${index}`,
    trustPolicyVersion: 'b3a-test-v1',
    details: rawReceipt ? { receipt: rawReceipt, ...(overrides.extraDetails || {}) }
      : (overrides.extraDetails || {}),
  };
}

function sqliteGraph(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-b3a-'));
  const graph = new Graph({
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
    useSQLite: true,
  });
  assert.ok(graph._db && graph._stmts, 'B3A SQLite tests require better-sqlite3');
  t.after(() => {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return graph;
}

function exactJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('V4-B3A: exact bounded JSON UTF-8 sizing', () => {
  it('matches Node JSON bytes for representative JSON-safe values', () => {
    const values = [
      null,
      true,
      false,
      0,
      -0,
      123.5,
      Number.NaN,
      'plain ASCII',
      'Türkçe ğüşİıöç',
      'emoji 😀🚀',
      'quote " slash \\ newline\n tab\t',
      '\ud800',
      [1, 'iki', null, { nested: 'değer' }],
      { z: 1, a: 'two', nested: { emoji: '🧪' } },
      receiptToCanonicalPayload(receipt(1)),
      receiptToCanonicalPayload(receipt(2, { v2: true })),
    ];
    const chain = buildMaterializedReceiptChain([
      auditEvent(1, receipt(1)),
      auditEvent(2, receipt(2, { v2: true })),
    ], { workspaceId: 'default' });
    assert.equal(chain.ok, true);
    values.push(exportReceiptBundle(chain.chain, {
      workspaceId: 'default',
      exportedAt: '2026-08-08T01:00:00.000Z',
    }));

    for (const value of values) {
      assert.equal(measureJsonUtf8Bytes(value), exactJsonBytes(value));
    }
  });

  it('enforces exact limit boundaries and does not stringify an over-limit whole value', () => {
    const value = { text: 'abc😀' };
    const exact = exactJsonBytes(value);
    assert.equal(measureJsonUtf8Bytes(value, { maxBytes: exact }), exact);
    assert.equal(measureJsonUtf8Bytes(value, { maxBytes: exact + 1 }), exact);
    assert.throws(() => measureJsonUtf8Bytes(value, { maxBytes: exact - 1 }), {
      code: SIZE_LIMIT_CODE,
    });

    const original = JSON.stringify;
    JSON.stringify = () => { throw new Error('whole-value stringify must not run'); };
    try {
      assert.throws(() => measureJsonUtf8Bytes('x'.repeat(100_000), { maxBytes: 32 }), {
        code: SIZE_LIMIT_CODE,
      });
    } finally {
      JSON.stringify = original;
    }
  });

  it('fails closed on circular and unsupported values', () => {
    const circular = {};
    circular.self = circular;
    assert.throws(() => measureJsonUtf8Bytes(circular), { code: CIRCULAR_REFERENCE_CODE });
    assert.throws(() => measureJsonUtf8Bytes(1n), { code: UNSUPPORTED_VALUE_CODE });
    assert.throws(() => measureJsonUtf8Bytes({ fn() {} }), { code: UNSUPPORTED_VALUE_CODE });
  });
});

describe('V4-B3A: bounded audit source', () => {
  it('filters in-memory events by workspace and rejects oversized details before yield', () => {
    const events = [
      auditEvent(1, null, { workspaceId: 'other', extraDetails: { blob: 'x'.repeat(500) } }),
      auditEvent(2, null, { workspaceId: 'default', extraDetails: { note: 'ok' } }),
    ];
    assert.deepEqual(
      [...iterateAuditEventsBounded(events, { workspaceId: 'default' }, { maxDetailsBytes: 64 })]
        .map((event) => event.auditId),
      ['audit-b3a-2'],
    );

    const oversized = [auditEvent(3, null, {
      workspaceId: 'default',
      extraDetails: { blob: 'x'.repeat(500) },
    })];
    assert.throws(() => [...iterateAuditEventsBounded(
      oversized, { workspaceId: 'default' }, { maxDetailsBytes: 64 },
    )], { code: AUDIT_EVENT_DETAILS_LIMIT_CODE });
  });

  it('checks SQLite persisted byte length before fetching full oversized details', () => {
    let detailsReads = 0;
    const header = {
      audit_id: 'audit-oversized', event_type: 'LEARN', target_type: 'edge', target_id: 'a|b',
      workspace_id: 'default', actor: 'test', timestamp: '2026-08-08T00:00:00.000Z',
      source_ref: '', provenance_id: '', trust_policy_version: '', details_bytes: 4096,
    };
    const source = {
      _stmts: {},
      _auditEvents: [],
      _db: {
        prepare(sql) {
          if (/SELECT details FROM audit_log/.test(sql)) {
            return { get() { detailsReads += 1; throw new Error('details must not be fetched'); } };
          }
          if (/timestamp > \?/.test(sql)) return { get() { return null; } };
          if (/WHERE audit_id = \? AND workspace_id = \? LIMIT 1/.test(sql)) {
            return { get() { return header; } };
          }
          return { get() { return header; } };
        },
      },
    };

    assert.throws(() => [...iterateAuditEventsBounded(
      source, { workspaceId: 'default' }, { maxDetailsBytes: 128 },
    )], { code: AUDIT_EVENT_DETAILS_LIMIT_CODE });
    assert.equal(detailsReads, 0);
  });

  it('uses real SQLite workspace-scoped keyset reads without legacy allAuditEvents.all()', (t) => {
    const graph = sqliteGraph(t);
    graph.appendAuditEvent(auditEvent(1, null, {
      workspaceId: 'other', extraDetails: { blob: 'x'.repeat(4096) },
    }));
    graph.appendAuditEvent(auditEvent(2, null, {
      workspaceId: 'default', extraDetails: { note: 'ok' },
    }));
    const originalAll = graph._stmts.allAuditEvents.all;
    graph._stmts.allAuditEvents.all = () => { throw new Error('legacy full audit read must not run'); };
    try {
      const rows = [...iterateAuditEventsBounded(
        graph, { workspaceId: 'default' }, { maxDetailsBytes: 128 },
      )];
      assert.deepEqual(rows.map((row) => row.auditId), ['audit-b3a-2']);
    } finally {
      graph._stmts.allAuditEvents.all = originalAll;
    }
  });

  it('fails closed when durable and process-local copies disagree without changing legacy semantics', (t) => {
    const graph = sqliteGraph(t);
    graph.appendAuditEvent(auditEvent(4, null, { extraDetails: { note: 'durable' } }));
    graph._auditEvents[graph._auditEvents.length - 1].details.note = 'memory-mutated';

    const legacy = graph.getAuditEvents({ workspaceId: 'default' });
    assert.equal(legacy[0].details.note, 'memory-mutated', 'legacy getAuditEvents remains last-memory-wins');
    assert.throws(() => [...iterateAuditEventsBounded(
      graph, { workspaceId: 'default' }, { maxDetailsBytes: 1024 },
    )], { code: AUDIT_EVENT_SOURCE_DIVERGENCE_CODE });
  });

  it('fails closed when a selected-workspace process-local audit event has no durable row', (t) => {
    const graph = sqliteGraph(t);
    graph._auditEvents.push(auditEvent(5, null, { extraDetails: { note: 'memory-only' } }));
    assert.throws(() => [...iterateAuditEventsBounded(
      graph, { workspaceId: 'default' }, { maxDetailsBytes: 1024 },
    )], { code: AUDIT_EVENT_SOURCE_DIVERGENCE_CODE });
  });

  it('contains no complete SQLite .all() read in the bounded module', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'audit-bounded-read.js'), 'utf8');
    assert.equal(source.includes('.all('), false);
    assert.equal(source.includes('allAuditEvents'), false);
  });
});

describe('V4-B3A: bounded receipt export', () => {
  it('exports and verifies an empty bundle', () => {
    const result = exportMaterializedReceiptBundleBounded([], {
      workspaceId: 'default',
      exportedAt: '2026-08-08T02:00:00.000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(result.bundle.receiptCount, 0);
    assert.equal(result.verification.valid, true);
    assert.equal(verifyExportedBundle(result.bundle).valid, true);
    assert.equal(result.serializedBytes, exactJsonBytes(result.bundle));
  });

  it('is deep-equal to legacy export for the same bounded V1/V2 source and exportedAt', () => {
    const events = [
      auditEvent(10, receipt(10)),
      auditEvent(11, receipt(11, { v2: true })),
    ];
    const opts = { workspaceId: 'default', exportedAt: '2026-08-08T03:00:00.000Z' };
    const legacy = exportMaterializedReceiptBundle(events, opts);
    const bounded = exportMaterializedReceiptBundleBounded(events, opts);
    assert.equal(legacy.ok, true);
    assert.equal(bounded.ok, true);
    assert.deepEqual(bounded.bundle, legacy.bundle);
    assert.equal(bounded.bundle.bundleHash, legacy.bundle.bundleHash);
    assert.equal(bounded.verification.valid, true);
  });

  it('counts duplicate receipt IDs once and preserves first-seen materialized behavior', () => {
    const first = receipt(20, { receiptId: 'receipt-duplicate', metadata: { source: 'first' } });
    const duplicate = receipt(21, { receiptId: 'receipt-duplicate', metadata: { source: 'second' } });
    const events = [auditEvent(20, first), auditEvent(21, duplicate), auditEvent(22, receipt(22))];
    const bounded = exportMaterializedReceiptBundleBounded(events, {
      exportedAt: '2026-08-08T04:00:00.000Z',
    });
    assert.equal(bounded.ok, true);
    assert.equal(bounded.bundle.receiptCount, 2);
    assert.equal(bounded.bundle.receipts[0].metadata.source, 'first');
  });

  it('stops immediately on unique receipt 1025 and never requests a later event', () => {
    const events = [];
    for (let i = 1; i <= MAX_RECEIPTS + 1; i += 1) {
      events.push(auditEvent(1000 + i, receipt(1000 + i)));
    }
    let touchedAfterLimit = false;
    Object.defineProperty(events, MAX_RECEIPTS + 1, {
      configurable: true,
      enumerable: true,
      get() {
        touchedAfterLimit = true;
        throw new Error('event after receipt 1025 must not be requested');
      },
    });
    events.length = MAX_RECEIPTS + 2;

    const result = exportMaterializedReceiptBundleBounded(events, {
      workspaceId: 'default',
      exportedAt: '2026-08-08T05:00:00.000Z',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MAX_RECEIPTS_EXCEEDED');
    assert.equal(result.error.observedReceipts, MAX_RECEIPTS + 1);
    assert.equal(touchedAfterLimit, false);
  });

  it('fails before retaining the record that crosses the aggregate receipt-array byte ceiling', () => {
    const events = [auditEvent(30, receipt(30)), auditEvent(31, receipt(31))];
    const chain = buildMaterializedReceiptChain(events, { workspaceId: 'default' });
    assert.equal(chain.ok, true);
    const oneBytes = exactJsonBytes([chain.chain[0]]);
    const twoBytes = exactJsonBytes(chain.chain);
    assert.ok(oneBytes < twoBytes);

    const result = exportMaterializedReceiptBundleBounded(events, {
      workspaceId: 'default',
      maxSerializedBundleBytes: twoBytes - 1,
      exportedAt: '2026-08-08T06:00:00.000Z',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED');
  });

  it('fails when the full bundle envelope crosses the exact byte ceiling', () => {
    const events = [auditEvent(40, receipt(40))];
    const legacy = exportMaterializedReceiptBundle(events, {
      workspaceId: 'default',
      exportedAt: '2026-08-08T07:00:00.000Z',
    });
    assert.equal(legacy.ok, true);
    const arrayBytes = exactJsonBytes(legacy.bundle.receipts);
    const bundleBytes = exactJsonBytes(legacy.bundle);
    assert.ok(arrayBytes < bundleBytes);

    const result = exportMaterializedReceiptBundleBounded(events, {
      workspaceId: 'default',
      maxSerializedBundleBytes: bundleBytes - 1,
      exportedAt: legacy.bundle.exportedAt,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED');
  });

  it('fails closed for invalid V2 trust authority and emits no bundle', () => {
    const invalid = receipt(50, { v2: true, trustRoot: 'local_operator' });
    invalid.trustRoot = 'forged_root';
    const result = exportMaterializedReceiptBundleBounded([auditEvent(50, invalid)], {
      workspaceId: 'default',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_RECEIPT');
    assert.equal(Object.hasOwn(result, 'bundle'), false);
  });

  it('rejects non-canonical workspaces before reading the source', () => {
    let read = false;
    const source = new Proxy([], {
      get(target, key, receiver) {
        if (key === Symbol.iterator) read = true;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = exportMaterializedReceiptBundleBounded(source, { workspaceId: 'other' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'WORKSPACE_NOT_ALLOWED');
    assert.equal(read, false);
  });

  it('refuses caller limits above the hard product ceilings', () => {
    assert.throws(() => exportMaterializedReceiptBundleBounded([], {
      maxReceipts: MAX_RECEIPTS + 1,
    }), /maxReceipts/);
    assert.throws(() => exportMaterializedReceiptBundleBounded([], {
      maxSerializedBundleBytes: MAX_SERIALIZED_BUNDLE_BYTES + 1,
    }), /maxSerializedBundleBytes/);
  });

  it('uses the bounded audit seam rather than the legacy getAuditEvents path', () => {
    const event = auditEvent(60, receipt(60));
    const source = [event];
    source.getAuditEvents = () => { throw new Error('legacy getAuditEvents must not be called'); };
    const result = exportMaterializedReceiptBundleBounded(source, {
      workspaceId: 'default',
      exportedAt: '2026-08-08T08:00:00.000Z',
    });
    assert.equal(result.ok, true);
  });

  it('publishes exactly the three new B3A runtime modules', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    for (const file of [
      'lib/audit-bounded-read.js',
      'lib/json-utf8-size.js',
      'lib/receipt/bounded-receipt-export.js',
    ]) {
      assert.ok(pkg.files.includes(file), `${file} must be published`);
    }
  });
});
