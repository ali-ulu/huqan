const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function makeTempPaths(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
  };
}

describe('memory persistence', () => {
  it('round-trips memory packages through JSON storage', () => {
    const paths = makeTempPaths('axiom-memory-json-');
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      memoryStorePath: paths.memoryPath,
    });

    const stored = kernel.memory.store({
      content: { text: 'persisted fact' },
      workspaceId: 'ws-json',
      metadata: { tag: 'json' },
    });
    assert.strictEqual(stored.ok, true);
    assert.strictEqual(stored.created, true);

    const linked = kernel.memory.store({
      content: { text: 'linked fact' },
      workspaceId: 'ws-json',
    });
    assert.strictEqual(linked.ok, true);

    const link = kernel.memory.link({
      fromMemoryId: stored.memory.memoryId,
      toMemoryId: linked.memory.memoryId,
      relation: 'supports',
      workspaceId: 'ws-json',
    });
    assert.strictEqual(link.ok, true);

    const tombstoned = kernel.memory.tombstone(linked.memory.memoryId, { workspaceId: 'ws-json' });
    assert.strictEqual(tombstoned.ok, true);

    const saveResult = kernel.memory.save();
    assert.strictEqual(saveResult.ok, true);
    assert.strictEqual(saveResult.backend, 'json');

    const reopened = new Kernel({
      noLoad: true,
      loadPlugins: false,
      memoryStorePath: paths.memoryPath,
    });
    const loadResult = reopened.memory.load();
    assert.strictEqual(loadResult.ok, true);

    const fetched = reopened.memory.get(stored.memory.memoryId, { workspaceId: 'ws-json' });
    assert.strictEqual(fetched.ok, true);
    assert.strictEqual(fetched.memory.content.text, 'persisted fact');

    const listed = reopened.memory.list({ workspaceId: 'ws-json', includeTombstoned: true });
    assert.strictEqual(listed.total, 2);
    assert.strictEqual(listed.memories.some((record) => record.status === 'deleted'), true);

    const links = reopened.memory.getLinks(stored.memory.memoryId);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].relation, 'supports');

    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  it('round-trips memory packages through SQLite when available', (t) => {
    const paths = makeTempPaths('axiom-memory-sqlite-');
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      memoryStoreUseSQLite: true,
      memoryStoreDbPath: paths.dbPath,
    });

    const saveResult = kernel.memory.save();
    if (saveResult.backend !== 'sqlite') {
      fs.rmSync(paths.dir, { recursive: true, force: true });
      return t.skip('better-sqlite3 is unavailable');
    }

    const first = kernel.memory.store({
      content: { text: 'sqlite fact' },
      workspaceId: 'ws-sqlite',
      provenance: {
        provenanceId: 'prov-sqlite-1',
        sourceRef: 'docs/sqlite.md#1',
        sourceTitle: 'SQLite Source',
        sourceType: 'document',
        actor: 'system',
        timestamp: '2026-06-12T00:00:00.000Z',
        confidence: 0.9,
        workspaceId: 'ws-sqlite',
        trustPolicyVersion: '1.0.0',
      },
    });
    assert.strictEqual(first.ok, true);

    const second = kernel.memory.store({
      content: { text: 'sqlite support' },
      workspaceId: 'ws-sqlite',
    });
    const rel = kernel.memory.link({
      fromMemoryId: first.memory.memoryId,
      toMemoryId: second.memory.memoryId,
      relation: 'supports',
      workspaceId: 'ws-sqlite',
    });
    assert.strictEqual(rel.ok, true);

    const persisted = kernel.memory.save();
    assert.strictEqual(persisted.ok, true);
    assert.strictEqual(persisted.backend, 'sqlite');

    const reopened = new Kernel({
      noLoad: true,
      loadPlugins: false,
      memoryStoreUseSQLite: true,
      memoryStoreDbPath: paths.dbPath,
    });
    const loaded = reopened.memory.load();
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.backend, 'sqlite');

    const fetched = reopened.memory.get(first.memory.memoryId, { workspaceId: 'ws-sqlite' });
    assert.strictEqual(fetched.ok, true);
    assert.strictEqual(fetched.memory.content.text, 'sqlite fact');
    assert.strictEqual(fetched.memory.provenance.sourceRef, 'docs/sqlite.md#1');

    const links = reopened.memory.getLinks(first.memory.memoryId);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].relation, 'supports');

    reopened.memory.close();
    reopened.graph.close();
    kernel.memory.close();
    kernel.graph.close();
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });
});
