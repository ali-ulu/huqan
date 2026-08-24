'use strict';

/**
 * A memory package is admitted as one graph, not as three independent lists
 * (#761).
 *
 * validateMemoryPackage runs each record through its own field validator, so a
 * package could be perfectly well formed and still import an audit history and
 * a relationship graph over memories that were never admitted -- absent from
 * the package entirely, or present but rejected by their own validation a few
 * lines earlier in the same import.
 *
 * Both backends are exercised: the in-memory store and the SQLite-backed one
 * must reach the same verdict, since the raw event/link arrays are what a
 * consumer reads back even when a query helper hides dangling rows.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MemoryStore = require('../lib/memory-store');
const { DANGLING_EVENT, DANGLING_LINK } = require('../lib/memory-package-import');

let tempDir;
let counter = 0;
const stores = new Set();

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-memory-package-'));
});

after(() => {
  for (const store of stores) {
    try { store.close(); } catch (_) {}
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function trackStore(store) {
  stores.add(store);
  return store;
}

const BACKENDS = [
  ['in-memory', () => new MemoryStore()],
  ['sqlite', () => new MemoryStore({ dbPath: path.join(tempDir, `store-${counter++}.db`), useSQLite: true })],
];

function provenance(ws = 'target-ws') {
  return {
    provenanceId: `prov-${counter++}`,
    sourceRef: 'axiom-memory-core',
    sourceTitle: 'AXIOM Memory Core',
    sourceType: 'memory-api',
    actor: 'system',
    timestamp: new Date().toISOString(),
    workspaceId: ws,
    trustPolicyVersion: '1.0.0',
    confidence: 1.0,
  };
}

function memory(memoryId, extra = {}) {
  return {
    memoryId,
    workspaceId: 'source-ws',
    content: `content-${memoryId}`,
    createdAt: '2026-06-03T00:00:00.000Z',
    provenance: provenance(),
    trustPolicyVersion: '1.0.0',
    ...extra,
  };
}

function event(eventId, memoryId) {
  return {
    eventId,
    eventType: 'CREATED',
    memoryId,
    workspaceId: 'source-ws',
    createdAt: '2026-06-03T00:00:01.000Z',
    actor: 'system',
    provenance: provenance(),
    trustPolicyVersion: '1.0.0',
    details: {},
  };
}

function link(linkId, fromMemoryId, toMemoryId) {
  return {
    linkId,
    relation: 'supports',
    fromMemoryId,
    toMemoryId,
    workspaceId: 'source-ws',
    createdAt: '2026-06-03T00:00:02.000Z',
    provenance: provenance(),
    trustPolicyVersion: '1.0.0',
  };
}

function pkg({ memories = [], events = [], links = [] }) {
  return {
    version: '1.0.0',
    schemaVersion: 'memory-package-v1',
    // These fixtures intentionally remap record-level source metadata, but
    // the package itself targets the workspace used by importInto().
    workspaceId: 'target-ws',
    memories,
    events,
    links,
  };
}

function importInto(store, contents, opts = {}) {
  return store.importPackage(pkg(contents), { targetWorkspaceId: 'target-ws', ...opts });
}

for (const [backendName, makeStore] of BACKENDS) {
  describe(`memory package references must resolve (${backendName}, #761)`, () => {
    it('a well-formed package still imports', () => {
      const store = trackStore(makeStore());
      const result = importInto(store, {
        memories: [memory('mem-a'), memory('mem-b')],
        events: [event('evt-a', 'mem-a')],
        links: [link('lnk-a', 'mem-a', 'mem-b')],
      });

      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.imported, { memories: 2, events: 1, links: 1 });
      assert.strictEqual(result.conflicts, undefined);
    });

    it('an event citing a memory nobody has is not imported', () => {
      const store = trackStore(makeStore());
      const result = importInto(store, {
        memories: [memory('mem-a')],
        events: [event('evt-a', 'mem-a'), event('evt-ghost', 'mem-never-existed')],
      });

      assert.strictEqual(result.imported.events, 1, 'a dangling event was imported');
      const conflict = result.conflicts.find(item => item.eventId === 'evt-ghost');
      assert.ok(conflict, 'the dangling event was dropped without saying so');
      assert.strictEqual(conflict.reason, DANGLING_EVENT);
      assert.strictEqual(conflict.memoryId, 'mem-never-existed');
    });

    it('a link with either endpoint missing is not imported', () => {
      const store = trackStore(makeStore());
      const result = importInto(store, {
        memories: [memory('mem-a')],
        links: [
          link('lnk-from', 'mem-missing', 'mem-a'),
          link('lnk-to', 'mem-a', 'mem-missing'),
          link('lnk-both', 'mem-missing', 'mem-other-missing'),
        ],
      });

      assert.strictEqual(result.imported.links, 0);
      assert.deepStrictEqual(
        result.conflicts.map(item => item.linkId).sort(),
        ['lnk-both', 'lnk-from', 'lnk-to'],
      );
      const both = result.conflicts.find(item => item.linkId === 'lnk-both');
      assert.strictEqual(both.reason, DANGLING_LINK);
      assert.deepStrictEqual(both.memoryIds, ['mem-missing', 'mem-other-missing']);
    });

    it('a package holding an invalid memory is refused before anything imports', () => {
      const store = trackStore(makeStore());
      // The other half of "dependents must not outlive their memory": a
      // memory that fails its own validation never reaches the import loop,
      // because validateMemoryPackage rejects the package as a whole. So the
      // event and link below are not selectively dropped -- nothing is
      // admitted at all.
      const result = importInto(store, {
        memories: [memory('mem-a'), memory('mem-bad', { status: 'not-a-status' })],
        events: [event('evt-bad', 'mem-bad')],
        links: [link('lnk-bad', 'mem-a', 'mem-bad')],
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'INVALID_PACKAGE');
      assert.strictEqual(store.get('mem-a', { workspaceId: 'target-ws' }).ok, false);
    });

    it('a conflicting memory still resolves, and the conflict is reported', () => {
      const store = trackStore(makeStore());
      const first = importInto(store, { memories: [memory('mem-a')] });
      assert.strictEqual(first.ok, true);

      // Same id, different content: the record exists, so an event about it is
      // not dangling -- but the disagreement is named in the result rather
      // than passed over.
      const result = importInto(store, {
        memories: [memory('mem-a', { content: 'different content' })],
        events: [event('evt-a', 'mem-a')],
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.imported.memories, 0);
      assert.strictEqual(result.imported.events, 1);
      assert.deepStrictEqual(result.conflicts.map(item => item.memoryId), ['mem-a']);
    });

    it('a reference to a memory already in the target workspace resolves', () => {
      const store = trackStore(makeStore());
      const seeded = store.store({ content: 'already here', workspaceId: 'target-ws' });
      assert.strictEqual(seeded.ok, true);

      const result = importInto(store, {
        memories: [memory('mem-a')],
        events: [event('evt-a', seeded.memory.memoryId)],
        links: [link('lnk-a', 'mem-a', seeded.memory.memoryId)],
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.imported.events, 1, 'a pre-existing memory was treated as missing');
      assert.strictEqual(result.imported.links, 1);
    });

    it('strict mode rolls the whole package back on a dangling reference', () => {
      const store = trackStore(makeStore());
      const result = importInto(store, {
        memories: [memory('mem-a'), memory('mem-b')],
        events: [event('evt-ghost', 'mem-never-existed')],
      }, { mode: 'strict' });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'CONFLICT');
      assert.strictEqual(result.error.details[0].reason, DANGLING_EVENT);

      // ...and nothing from the package survived, not even the valid memories.
      assert.strictEqual(store.get('mem-a', { workspaceId: 'target-ws' }).ok, false);
      assert.strictEqual(store.get('mem-b', { workspaceId: 'target-ws' }).ok, false);
    });

    it('idempotent mode reports the dependency instead of importing it', () => {
      const store = trackStore(makeStore());
      const result = importInto(store, {
        memories: [memory('mem-a')],
        events: [event('evt-ghost', 'mem-never-existed')],
        links: [link('lnk-ghost', 'mem-a', 'mem-never-existed')],
      });

      // Partial import remains supported, but the dropped records are named.
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.imported.memories, 1);
      assert.strictEqual(result.imported.events, 0);
      assert.strictEqual(result.imported.links, 0);
      assert.strictEqual(result.conflicts.length, 2);
    });

    it('leaves no dangling row behind in the store it exports from', () => {
      const store = trackStore(makeStore());
      importInto(store, {
        memories: [memory('mem-a')],
        events: [event('evt-a', 'mem-a'), event('evt-ghost', 'mem-never-existed')],
        links: [link('lnk-ghost', 'mem-a', 'mem-missing')],
      });

      const exported = store.exportPackage({ workspaceId: 'target-ws' });
      assert.strictEqual(exported.ok, true);
      const memoryIds = new Set(exported.package.memories.map(item => item.memoryId));
      for (const evt of exported.package.events) {
        assert.ok(memoryIds.has(evt.memoryId), `exported event ${evt.eventId} cites a missing memory`);
      }
      for (const lnk of exported.package.links) {
        assert.ok(memoryIds.has(lnk.fromMemoryId) && memoryIds.has(lnk.toMemoryId),
          `exported link ${lnk.linkId} cites a missing memory`);
      }
    });
  });
}

describe('both backends agree on referential admission (#761)', () => {
  it('produces the same verdict and counts', () => {
    const contents = {
      memories: [memory('mem-a')],
      events: [event('evt-a', 'mem-a'), event('evt-ghost', 'mem-absent')],
      links: [link('lnk-ok', 'mem-a', 'mem-a'), link('lnk-ghost', 'mem-a', 'mem-absent')],
    };

    const results = BACKENDS.map(([, makeStore]) => {
      const result = importInto(trackStore(makeStore()), contents);
      return {
        ok: result.ok,
        imported: result.imported,
        conflictKeys: (result.conflicts || []).map(item => `${item.type}:${item.eventId || item.linkId || item.memoryId}`).sort(),
      };
    });

    assert.deepStrictEqual(results[0], results[1]);
  });
});
