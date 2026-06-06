'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');

function createStore(opts) {
  return new MemoryStore(opts);
}

function makeValidProvenance(actor, ws) {
  return {
    provenanceId: 'prov-' + Math.random().toString(36).slice(2, 9),
    sourceRef: 'axiom-memory-core',
    sourceTitle: 'AXIOM Memory Core',
    sourceType: 'memory-api',
    actor: actor || 'system',
    timestamp: new Date().toISOString(),
    workspaceId: ws || 'default',
    trustPolicyVersion: '1.0.0',
    confidence: 1.0,
  };
}

describe('memory-package-roundtrip', () => {
  describe('exportPackage', () => {
    it('exports memories, events, links for a workspace', () => {
      const store = createStore();
      const m1 = store.store({ content: 'memory-1', workspaceId: 'ws-test' });
      const m2 = store.store({ content: 'memory-2', workspaceId: 'ws-test' });
      store.linkMemories({
        fromMemoryId: m1.memory.memoryId,
        toMemoryId: m2.memory.memoryId,
        relation: 'supports',
        workspaceId: 'ws-test',
      });

      const result = store.exportPackage({ workspaceId: 'ws-test' });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.package.workspaceId, 'ws-test');
      assert.strictEqual(result.package.memories.length, 2);
      assert.strictEqual(result.package.events.length, 3);
      assert.strictEqual(result.package.links.length, 1);
    });

    it('exports only requested workspace (workspace isolation)', () => {
      const store = createStore();
      store.store({ content: 'ws-a', workspaceId: 'ws-a' });
      store.store({ content: 'ws-b', workspaceId: 'ws-b' });

      const resultA = store.exportPackage({ workspaceId: 'ws-a' });
      assert.strictEqual(resultA.ok, true);
      assert.strictEqual(resultA.package.memories.length, 1);

      const resultB = store.exportPackage({ workspaceId: 'ws-b' });
      assert.strictEqual(resultB.ok, true);
      assert.strictEqual(resultB.package.memories.length, 1);
    });

    it('excludes tombstoned memories by default', () => {
      const store = createStore();
      const m1 = store.store({ content: 'active' });
      const m2 = store.store({ content: 'to-tombstone' });
      store.tombstone(m2.memory.memoryId);

      const result = store.exportPackage({});
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.package.memories.length, 1);
      assert.strictEqual(result.package.memories[0].status, 'active');
    });

    it('includes tombstoned memories when requested', () => {
      const store = createStore();
      const m1 = store.store({ content: 'active' });
      const m2 = store.store({ content: 'tombstoned' });
      store.tombstone(m2.memory.memoryId);

      const result = store.exportPackage({ includeTombstoned: true });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.package.memories.length, 2);
    });

    it('preserves schemaVersion and version fields', () => {
      const store = createStore();
      store.store({ content: 'test' });

      const result = store.exportPackage({});
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.package.version, '1.0.0');
      assert.strictEqual(result.package.schemaVersion, 'memory-package-v1');
    });

    it('preserves supersede chain', () => {
      const store = createStore();
      const m1 = store.store({ content: 'v1' });
      store.supersede(m1.memory.memoryId, 'v2');

      const result = store.exportPackage({});
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.package.memories.length, 2);
      const v2 = result.package.memories.find(m => m.supersedesMemoryId);
      assert.ok(v2);
      assert.strictEqual(v2.supersedesMemoryId, m1.memory.memoryId);
      assert.strictEqual(result.package.links.length, 1);
      assert.strictEqual(result.package.links[0].relation, 'supersedes');
    });

    it('preserves provenance on exported records', () => {
      const store = createStore();
      const prov = makeValidProvenance('export-test');
      store.store({ content: 'tracked', provenance: prov });

      const result = store.exportPackage({});
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.package.memories[0].provenance.actor, 'export-test');
    });

    it('exports TOMBSTONE events', () => {
      const store = createStore();
      const m = store.store({ content: 'to-delete' });
      store.tombstone(m.memory.memoryId);

      const result = store.exportPackage({ includeTombstoned: true });
      assert.strictEqual(result.ok, true);
      const tombEvent = result.package.events.find(e => e.eventType === 'TOMBSTONE');
      assert.ok(tombEvent);
    });
  });

  describe('importPackage', () => {
    it('imports memories, events, links into target workspace', () => {
      const store = createStore();
      const pkg = {
        version: '1.0.0',
        schemaVersion: 'memory-package-v1',
        workspaceId: 'source-ws',
        memories: [
          { memoryId: 'mem-import-1', workspaceId: 'source-ws', content: 'imported-1', createdAt: '2026-06-03T00:00:00.000Z', provenance: makeValidProvenance(null, 'target-ws'), trustPolicyVersion: '1.0.0' },
          { memoryId: 'mem-import-2', workspaceId: 'source-ws', content: 'imported-2', createdAt: '2026-06-03T00:00:01.000Z', provenance: makeValidProvenance(null, 'target-ws'), trustPolicyVersion: '1.0.0' },
        ],
        events: [
          { eventId: 'evt-import-1', eventType: 'CREATED', memoryId: 'mem-import-1', workspaceId: 'source-ws', createdAt: '2026-06-03T00:00:00.000Z', actor: 'system', provenance: makeValidProvenance(null, 'target-ws'), trustPolicyVersion: '1.0.0', details: {} },
          { eventId: 'evt-import-2', eventType: 'CREATED', memoryId: 'mem-import-2', workspaceId: 'source-ws', createdAt: '2026-06-03T00:00:01.000Z', actor: 'system', provenance: makeValidProvenance(null, 'target-ws'), trustPolicyVersion: '1.0.0', details: {} },
        ],
        links: [
          { linkId: 'link-import-1', relation: 'supports', fromMemoryId: 'mem-import-1', toMemoryId: 'mem-import-2', workspaceId: 'source-ws', createdAt: '2026-06-03T00:00:02.000Z', provenance: makeValidProvenance(null, 'target-ws'), trustPolicyVersion: '1.0.0' },
        ],
      };

      const result = store.importPackage(pkg, { targetWorkspaceId: 'target-ws' });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.imported.memories, 2);
      assert.strictEqual(result.imported.events, 2);
      assert.strictEqual(result.imported.links, 1);
    });

    it('rejects malformed package (missing required fields)', () => {
      const store = createStore();
      const result = store.importPackage({ version: '1.0.0' }, {});
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'INVALID_PACKAGE');
    });

    it('rejects corrupted package (invalid memory in array)', () => {
      const store = createStore();
      const pkg = {
        version: '1.0.0',
        schemaVersion: 'memory-package-v1',
        workspaceId: 'ws',
        memories: [{ invalidMemory: true }],
        events: [],
        links: [],
      };
      const result = store.importPackage(pkg, {});
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'INVALID_PACKAGE');
    });

    it('targetWorkspaceId remaps all records to target workspace', () => {
      const store = createStore();
      const pkg = {
        version: '1.0.0',
        schemaVersion: 'memory-package-v1',
        workspaceId: 'source-ws',
        memories: [{ memoryId: 'remapped', workspaceId: 'target-ws', content: 'content', createdAt: '2026-06-03T00:00:00.000Z', provenance: makeValidProvenance(null, 'target-ws'), trustPolicyVersion: '1.0.0' }],
        events: [{ eventId: 'evt-remapped', eventType: 'CREATED', memoryId: 'remapped', workspaceId: 'target-ws', createdAt: '2026-06-03T00:00:00.000Z', actor: 'system', provenance: makeValidProvenance(null, 'target-ws'), trustPolicyVersion: '1.0.0', details: {} }],
        links: [],
      };

      const result = store.importPackage(pkg, { targetWorkspaceId: 'target-ws' });
      assert.strictEqual(result.ok, true);

      const getResult = store.get('remapped', { workspaceId: 'target-ws' });
      assert.strictEqual(getResult.ok, true);
      assert.strictEqual(getResult.memory.workspaceId, 'target-ws');
    });

    it('same ID + same content is idempotent (skipped)', () => {
      const store = createStore();
      const m1 = store.store({ content: 'existing' });

      const pkg = {
        version: '1.0.0',
        schemaVersion: 'memory-package-v1',
        workspaceId: 'ws',
        memories: [{
          memoryId: m1.memory.memoryId,
          workspaceId: 'ws',
          content: 'existing',
          createdAt: m1.memory.createdAt,
          provenance: m1.memory.provenance,
          trustPolicyVersion: '1.0.0',
        }],
        events: [],
        links: [],
      };

      const result = store.importPackage(pkg, { targetWorkspaceId: 'ws' });
      assert.strictEqual(result.ok, true);
      const check = store.get(m1.memory.memoryId);
      assert.strictEqual(check.memory.content, 'existing');
    });

    it('same ID + different content returns conflict in idempotent mode', () => {
      const store = createStore();
      const m1 = store.store({ content: 'original', workspaceId: 'ws' });

      const pkg = {
        version: '1.0.0',
        schemaVersion: 'memory-package-v1',
        workspaceId: 'ws',
        memories: [{
          memoryId: m1.memory.memoryId,
          workspaceId: m1.memory.workspaceId,
          content: 'different-content',
          createdAt: m1.memory.createdAt,
          provenance: m1.memory.provenance,
          trustPolicyVersion: '1.0.0',
        }],
        events: [],
        links: [],
      };

      const result = store.importPackage(pkg, { targetWorkspaceId: 'ws', mode: 'idempotent' });
      assert.strictEqual(result.ok, true);
      assert.ok(result.conflicts);
    });

    it('idempotent mode preserves original on conflict', () => {
      const store = createStore();
      const m1 = store.store({ content: 'original', workspaceId: 'ws' });

      const pkg = {
        version: '1.0.0',
        schemaVersion: 'memory-package-v1',
        workspaceId: 'ws',
        memories: [{
          memoryId: m1.memory.memoryId,
          workspaceId: m1.memory.workspaceId,
          content: 'different-content',
          createdAt: m1.memory.createdAt,
          provenance: m1.memory.provenance,
          trustPolicyVersion: '1.0.0',
        }],
        events: [],
        links: [],
      };

      const result = store.importPackage(pkg, { targetWorkspaceId: 'ws', mode: 'idempotent' });
      assert.strictEqual(result.ok, true);

      const check = store.get(m1.memory.memoryId, { workspaceId: 'ws' });
      assert.strictEqual(check.memory.content, 'original');
    });
  });

  describe('full roundtrip', () => {
    it('export → import → export is stable', () => {
      const store1 = createStore();
      const m1 = store1.store({ content: 'first', workspaceId: 'roundtrip-ws' });
      const m2 = store1.store({ content: 'second', workspaceId: 'roundtrip-ws' });
      store1.linkMemories({ fromMemoryId: m1.memory.memoryId, toMemoryId: m2.memory.memoryId, relation: 'supports', workspaceId: 'roundtrip-ws' });

      const exported = store1.exportPackage({ workspaceId: 'roundtrip-ws' });
      assert.strictEqual(exported.ok, true);

      const store2 = createStore();
      const imported = store2.importPackage(exported.package, { targetWorkspaceId: 'roundtrip-ws' });
      assert.strictEqual(imported.ok, true);

      const reExported = store2.exportPackage({ workspaceId: 'roundtrip-ws' });
      assert.strictEqual(reExported.ok, true);
      assert.strictEqual(reExported.package.memories.length, 2);
      assert.strictEqual(reExported.package.links.length, 1);
    });
  });
});