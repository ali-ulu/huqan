'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MemoryStore = require('../lib/memory-store');
const { runQuery } = require('../lib/memory-query-engine');

test('SQLite query uses an indexed bounded page and preserves filters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-query-page-'));
  const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 'memory.db') });
  try {
    for (let i = 0; i < 12; i++) {
      assert.equal(store.store({ workspaceId: 'ws-a', content: `item-${i}` }).ok, true);
    }
    assert.equal(store.store({ workspaceId: 'ws-b', content: 'other workspace' }).ok, true);
    for (const opts of [
      { workspaceId: 'ws-a', limit: 3, offset: 4 },
      { workspaceId: 'ws-a', orderBy: 'memoryId', order: 'desc', limit: 3 },
      { workspaceId: 'ws-a', orderBy: 'updatedAt', limit: 2 },
      { workspaceId: 'ws-a', status: 'deleted', limit: 2 },
      { workspaceId: 'ws-a', limit: 1.5, offset: 2.5 },
      // #3640: the indexed path and the engine must agree on the workspace's
      // unfiltered count, or a caller could read two different stores.
      { workspaceId: 'ws-a', storeTotal: true, limit: 3, offset: 4 },
      { workspaceId: 'ws-a', status: 'deleted', storeTotal: true, limit: 2 },
    ]) {
      assert.deepEqual(store.query(opts), runQuery({ memories: store._memories }, opts));
    }
    assert.equal(store.query({ workspaceId: 'ws-a', storeTotal: true }).storeTotal, 12);
    assert.equal(store.list({ workspaceId: 'ws-a', includeDeleted: true }).total, 12);
    const expected = store.query({ workspaceId: 'ws-a', limit: 3, offset: 4 });
    assert.equal(expected.total, 12);
    const plan = store._db.prepare("EXPLAIN QUERY PLAN SELECT memory_id FROM memories WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC, memory_id ASC LIMIT ? OFFSET ?")
      .all('ws-a', 3, 4);
    assert.ok(plan.some((row) => /idx_memories_workspace_status_created/.test(row.detail)));
    const unsafePlan = store._db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM memories INDEXED BY idx_memories_workspace_locale_unsafe WHERE workspace_id = ? AND memory_id GLOB '*[^0-9a-f]*' LIMIT 1").all('ws-a');
    assert.ok(unsafePlan.some((row) => /idx_memories_workspace_locale_unsafe/.test(row.detail)),
      JSON.stringify(unsafePlan));

    const originalValues = store._memories.values;
    store._memories.values = () => { throw new Error('full memory scan'); };
    try {
      assert.deepEqual(store.query({ workspaceId: 'ws-a', limit: 3, offset: 4 }), expected);
      assert.equal(store.list({ workspaceId: 'ws-a', limit: 3, offset: 4 }).memories.length, 3);
      assert.equal(store.query({ workspaceId: 'ws-b', limit: 1 }).total, 1);
      assert.equal(store.query({ workspaceId: 'ws-a', status: 'deleted', limit: 3 }).total, 0);
    } finally {
      store._memories.values = originalValues;
    }
    // Filters that cannot use the index retain their previous semantics.
    assert.equal(store.query({ workspaceId: 'ws-a', contentIncludes: 'item-1' }).total, 3);
  } finally {
    store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
});

test('SQLite page ordering matches the existing locale ordering for imported ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-query-locale-'));
  const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 'memory.db') });
  try {
    const insert = store._db.prepare(`INSERT INTO memories
      (workspace_id, memory_id, kind, content_json, content_hash, status,
       metadata_json, provenance_json, trust_policy_version, created_at)
      VALUES (?, ?, 'memory-record', '"x"', '', 'active', '{}', '{}', '1.0.0', ?)`);
    for (const id of ['a', 'B', 'ä']) {
      insert.run('ws', id, '2026-01-01T00:00:00.000Z');
      store._memories.set(store.makeMemoryKey('ws', id), { memoryId: id, workspaceId: 'ws',
        kind: 'memory-record', content: 'x', status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
        metadata: {}, provenance: {} });
    }
    const opts = { workspaceId: 'ws', limit: 1, offset: 1 };
    assert.deepEqual(store.query(opts), runQuery({ memories: store._memories }, opts));
  } finally {
    store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
});

test('SQLite query retains imported non-default kinds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-query-kind-'));
  const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 'memory.db') });
  try {
    const id = 'abcdef';
    const createdAt = '2026-01-01T00:00:00.000Z';
    store._db.prepare(`INSERT INTO memories
      (workspace_id, memory_id, kind, content_json, content_hash, status,
       metadata_json, provenance_json, trust_policy_version, created_at)
      VALUES (?, ?, 'imported-kind', '"x"', '', 'active', '{}', '{}', '1.0.0', ?)`)
      .run('ws', id, createdAt);
    store._memories.set(store.makeMemoryKey('ws', id), {
      memoryId: id, workspaceId: 'ws', kind: 'imported-kind', content: 'x',
      status: 'active', createdAt, metadata: {}, provenance: {},
    });
    const opts = { workspaceId: 'ws', kind: 'imported-kind', limit: 1 };
    assert.deepEqual(store.query(opts), runQuery({ memories: store._memories }, opts));
    // An explicit default kind also falls back so counting matches the engine.
    const defaultOpts = { workspaceId: 'ws', kind: 'memory-record', limit: 1 };
    assert.deepEqual(store.query(defaultOpts), runQuery({ memories: store._memories }, defaultOpts));
    assert.equal(store.query(defaultOpts).total, 0);
  } finally {
    store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
});
