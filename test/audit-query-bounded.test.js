const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');
const { queryAuditTrail, queryAuditTrailPage } = require('../lib/provenance-query');
const { AUDIT_QUERY_MAX_LIMIT, clampAuditLimit } = require('../lib/audit-query');

let tempDir;
const graphs = new Set();

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-audit-query-'));
});

after(() => {
  for (const graph of graphs) {
    try { graph.close(); } catch (_) {}
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeGraph(name, useSQLite = true) {
  const graph = new Graph({
    memoryPath: path.join(tempDir, `${name}.json`),
    useSQLite,
    noLoad: true,
  });
  graphs.add(graph);
  return graph;
}

/**
 * Seeds `noise` unrelated events plus `wanted` events for one target, so a
 * selective query has a large history it must not read.
 */
function seedHistory(graph, { noise, wanted, targetId = 'wanted-target', workspaceId = 'default' }) {
  for (let i = 0; i < noise; i++) {
    graph.appendAuditEvent({
      eventType: 'memory.write',
      targetType: 'node',
      targetId: `noise-${String(i).padStart(5, '0')}`,
      workspaceId,
      actor: 'system',
    });
  }
  for (let i = 0; i < wanted; i++) {
    graph.appendAuditEvent({
      eventType: 'APPROVAL_APPROVED',
      targetType: 'node',
      targetId,
      workspaceId,
      actor: 'reviewer',
    });
  }
}

function instrumentMaterialization(graph) {
  const original = graph._stmts.allAuditEvents.all.bind(graph._stmts.allAuditEvents);
  const counter = { calls: 0 };
  graph._stmts.allAuditEvents.all = (...args) => {
    counter.calls += 1;
    return original(...args);
  };
  counter.restore = () => { graph._stmts.allAuditEvents.all = original; };
  return counter;
}

describe('audit trail queries are bounded (#729)', () => {
  it('a selective query does not materialize the whole table', () => {
    const graph = makeGraph('selective');
    seedHistory(graph, { noise: 800, wanted: 3 });

    const probe = instrumentMaterialization(graph);
    try {
      const page = queryAuditTrailPage(graph, { workspaceId: 'default', targetId: 'wanted-target' });
      assert.strictEqual(page.items.length, 3);
      assert.strictEqual(page.hasMore, false);
      assert.ok(page.items.every((event) => event.targetId === 'wanted-target'));
      assert.strictEqual(probe.calls, 0, 'a selective query must not read every audit row');
    } finally {
      probe.restore();
    }
  });

  it('caps the page even when the caller asks for everything', () => {
    const graph = makeGraph('capped');
    seedHistory(graph, { noise: 0, wanted: 260, targetId: 'bulk' });

    const unbounded = queryAuditTrailPage(graph, { workspaceId: 'default', targetId: 'bulk', limit: 100000 });
    assert.ok(unbounded.items.length <= AUDIT_QUERY_MAX_LIMIT);
    assert.strictEqual(unbounded.limit, AUDIT_QUERY_MAX_LIMIT);

    const defaulted = queryAuditTrailPage(graph, { workspaceId: 'default', targetId: 'bulk' });
    assert.strictEqual(defaulted.items.length, 100);
    assert.strictEqual(defaulted.hasMore, true);
    assert.ok(defaulted.nextCursor);
  });

  it('clampAuditLimit refuses non-positive and non-numeric limits', () => {
    assert.strictEqual(clampAuditLimit(undefined), 100);
    assert.strictEqual(clampAuditLimit(''), 100);
    assert.strictEqual(clampAuditLimit('abc'), 100);
    assert.strictEqual(clampAuditLimit(0), 100);
    assert.strictEqual(clampAuditLimit(-5), 100);
    assert.strictEqual(clampAuditLimit(10), 10);
    assert.strictEqual(clampAuditLimit(10_000), AUDIT_QUERY_MAX_LIMIT);
  });

  it('keyset cursors walk the whole result exactly once, in order', () => {
    const graph = makeGraph('cursor-walk');
    seedHistory(graph, { noise: 0, wanted: 250, targetId: 'walk' });

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = queryAuditTrailPage(graph, {
        workspaceId: 'default',
        targetId: 'walk',
        limit: 40,
        cursor,
      });
      assert.ok(page.items.length <= 40);
      seen.push(...page.items.map((event) => event.auditId));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 50, 'pagination did not terminate');
    } while (cursor);

    assert.strictEqual(seen.length, 250);
    assert.strictEqual(new Set(seen).size, 250, 'cursor pages must not overlap');
  });

  it('descending order returns the reverse sequence', () => {
    const graph = makeGraph('order');
    seedHistory(graph, { noise: 0, wanted: 25, targetId: 'ordered' });

    const asc = queryAuditTrailPage(graph, { workspaceId: 'default', targetId: 'ordered', order: 'asc' });
    const desc = queryAuditTrailPage(graph, { workspaceId: 'default', targetId: 'ordered', order: 'desc' });

    assert.strictEqual(asc.items.length, 25);
    assert.strictEqual(desc.items.length, 25);
    assert.deepStrictEqual(
      desc.items.map((event) => event.auditId),
      [...asc.items].reverse().map((event) => event.auditId),
    );
  });

  it('keeps workspaces isolated', () => {
    const graph = makeGraph('isolation');
    seedHistory(graph, { noise: 0, wanted: 6, targetId: 'shared', workspaceId: 'tenant-a' });
    seedHistory(graph, { noise: 0, wanted: 4, targetId: 'shared', workspaceId: 'tenant-b' });

    const a = queryAuditTrailPage(graph, { workspaceId: 'tenant-a', targetId: 'shared' });
    const b = queryAuditTrailPage(graph, { workspaceId: 'tenant-b', targetId: 'shared' });

    assert.strictEqual(a.items.length, 6);
    assert.strictEqual(b.items.length, 4);
    assert.ok(a.items.every((event) => event.workspaceId === 'tenant-a'));
    assert.ok(b.items.every((event) => event.workspaceId === 'tenant-b'));
  });

  it('matches the materializing path for the same selective filter', () => {
    const graph = makeGraph('parity');
    seedHistory(graph, { noise: 120, wanted: 9, targetId: 'parity-target' });

    const bounded = queryAuditTrailPage(graph, { workspaceId: 'default', targetId: 'parity-target' }).items;
    const direct = graph.getAuditEvents({ workspaceId: 'default', targetId: 'parity-target' });

    assert.strictEqual(bounded.length, direct.length);
    assert.deepStrictEqual(
      bounded.map((event) => event.auditId).sort(),
      direct.map((event) => event.auditId).sort(),
    );
  });

  it('produces the same page without SQLite', () => {
    const graph = makeGraph('no-sqlite', false);
    seedHistory(graph, { noise: 40, wanted: 5, targetId: 'json-target' });

    const page = queryAuditTrailPage(graph, { workspaceId: 'default', targetId: 'json-target', limit: 3 });
    assert.strictEqual(page.items.length, 3);
    assert.strictEqual(page.hasMore, true);
    assert.ok(page.nextCursor);

    const rest = queryAuditTrailPage(graph, {
      workspaceId: 'default',
      targetId: 'json-target',
      limit: 3,
      cursor: page.nextCursor,
    });
    assert.strictEqual(rest.items.length, 2);
    assert.strictEqual(rest.hasMore, false);
  });

  it('queryAuditTrail keeps its array shape for existing callers', () => {
    const graph = makeGraph('array-shape');
    seedHistory(graph, { noise: 0, wanted: 4, targetId: 'legacy' });

    const trail = queryAuditTrail(graph, { workspaceId: 'default', targetId: 'legacy' });
    assert.ok(Array.isArray(trail));
    assert.strictEqual(trail.length, 4);
  });

  it('ignores a malformed cursor instead of failing the query', () => {
    const graph = makeGraph('bad-cursor');
    seedHistory(graph, { noise: 0, wanted: 3, targetId: 'cursorless' });

    const page = queryAuditTrailPage(graph, {
      workspaceId: 'default',
      targetId: 'cursorless',
      cursor: 'not-a-real-cursor!!',
    });
    assert.strictEqual(page.items.length, 3);
  });
});
