'use strict';

/**
 * #4243: the public trust-badge routes read a caller-chosen receipt id through
 * the materialized projection, which materializes a workspace's entire audit
 * history on every call. The projection is now cached per source, keyed on the
 * bounded `countAuditEvents({ workspaceId })` primitive, so repeated reads of
 * the same workspace are O(1) and an append still invalidates the entry.
 *
 * These tests drive the real graph read source (a Kernel), not a stub, so the
 * bounded primitive and the projection are the ones the server uses.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('../kernel');
const { readReceiptById } = require('../lib/receipt/receipt-read-index');

function makeKernel(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4243-'));
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(tempDir, 'memory.json'),
    dbPath: null,
  });
  t.after(() => {
    try { kernel.graph.close?.(); } catch (_) {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return kernel;
}

// A workspace with real audit events: append audit rows so the bounded
// COUNT(*) primitive returns a positive, changing value.
function seed(graph, count) {
  for (let i = 0; i < count; i++) {
    graph.appendAuditEvent({
      eventType: 'test_seed',
      targetType: 'node',
      targetId: `seed-${i}`,
      workspaceId: 'default',
      timestamp: new Date(1700000000000 + i).toISOString(),
      details: {},
    });
  }
}

test('#4243 repeated reads of one workspace do not re-materialize the audit history', t => {
  const kernel = makeKernel(t);
  const graph = kernel.graph;
  seed(graph, 40);

  const source = graph;
  const original = source.getAuditEvents.bind(source);
  let materializeCalls = 0;
  source.getAuditEvents = (filters) => { materializeCalls += 1; return original(filters); };

  readReceiptById(source, 'missing-0', { workspaceId: 'default' });
  const afterCold = materializeCalls;
  assert.ok(afterCold >= 1, 'the first read must materialize');

  for (let i = 1; i < 25; i++) {
    readReceiptById(source, `missing-${i}`, { workspaceId: 'default' });
  }
  assert.equal(
    materializeCalls,
    afterCold,
    'the warm reads must be served from the cache, not re-materialized',
  );
});

test('#4243 an appended audit event invalidates the cached projection', t => {
  const kernel = makeKernel(t);
  const graph = kernel.graph;
  seed(graph, 10);

  const original = graph.getAuditEvents.bind(graph);
  let materializeCalls = 0;
  graph.getAuditEvents = (filters) => { materializeCalls += 1; return original(filters); };

  readReceiptById(graph, 'missing', { workspaceId: 'default' });
  readReceiptById(graph, 'missing', { workspaceId: 'default' });
  const warmCalls = materializeCalls;
  assert.equal(warmCalls, 1, 'the second read must be served from the cache');

  const before = graph.countAuditEvents({ workspaceId: 'default' });
  graph.appendAuditEvent({
    eventType: 'post_cache',
    targetType: 'node',
    targetId: 'post-cache',
    workspaceId: 'default',
    timestamp: new Date().toISOString(),
    details: {},
  });
  const after = graph.countAuditEvents({ workspaceId: 'default' });
  assert.ok(after > before, 'the append must change the bounded count the cache keys on');

  // The count moved, so the next read must re-materialize rather than serve the
  // pre-append projection as fresh.
  readReceiptById(graph, 'missing', { workspaceId: 'default' });
  assert.equal(materializeCalls, warmCalls + 1, 'the append must invalidate the cache');
});

test('#4243 a source without the bounded primitive is never cached (legacy path intact)', () => {
  // An array fixture has no countAuditEvents, so the cache is bypassed entirely
  // and the structural-validation path is unchanged.
  const events = [
    { auditId: 'a1', workspaceId: 'default', timestamp: '2024-01-01T00:00:00.000Z', details: {} },
    { auditId: 'a2', workspaceId: 'default', timestamp: '2024-01-02T00:00:00.000Z', details: {} },
  ];
  const first = readReceiptById(events, 'nope', { workspaceId: 'default' });
  const second = readReceiptById(events, 'nope', { workspaceId: 'default' });
  assert.equal(first.status, 'not_found');
  assert.equal(second.status, 'not_found');
});

test('#4243 a bounded primitive that throws or returns junk falls back to the uncached read', () => {
  // countAuditEvents is a storage query; a source may not implement it (array
  // fixture) or it may fail. Either way the cache must be skipped, not keyed on
  // a value that is not a count: the read stays correct, only slower.
  const events = [
    { auditId: 'a1', workspaceId: 'default', timestamp: '2024-01-01T00:00:00.000Z', details: {} },
    { auditId: 'a2', workspaceId: 'default', timestamp: '2024-01-02T00:00:00.000Z', details: {} },
  ];

  const throwing = events.slice();
  throwing.countAuditEvents = () => { throw new Error('storage unavailable'); };
  assert.equal(readReceiptById(throwing, 'nope', { workspaceId: 'default' }).status, 'not_found');
  assert.equal(readReceiptById(throwing, 'nope', { workspaceId: 'default' }).status, 'not_found');

  for (const junk of [-1, Number.NaN, Number.POSITIVE_INFINITY, '12', null]) {
    const source = events.slice();
    source.countAuditEvents = () => junk;
    assert.equal(
      readReceiptById(source, 'nope', { workspaceId: 'default' }).status,
      'not_found',
      `countAuditEvents returning ${String(junk)} must bypass the cache`,
    );
  }
});

