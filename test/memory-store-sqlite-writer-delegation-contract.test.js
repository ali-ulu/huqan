'use strict';

// #2129: SQLite write path (schema, statements, per-operation persist) lives
// in lib/memory-store-sqlite-writer.js. The store keeps handle/collection
// ownership and delegates. No cycle back: the writer receives the store as
// an argument and never requires it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store-sqlite-writer.js');
const { readMemoryStoreChain } = require('./helpers/memory-store-chain-source');
// #2120: the store implementation is the entry plus its installed method-group
// chain; moved facades keep their verbatim shape, so the pins below hold.
const storeSource = readMemoryStoreChain(STORE_SOURCE);
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('#2129: SQLite write path is delegated to the writer module', () => {
  assert.ok(
    storeSource.includes("require('./memory-store-sqlite-writer')"),
    'lib/memory-store.js imports the sqlite writer',
  );
  for (const name of [
    'initMemorySchema',
    'createMemoryStmts',
    'openMemoryDatabase',
    'persistStoreWrite',
    'persistLinkMemories',
    'persistPatchMetadata',
    'persistTombstone',
    'persistSupersede',
    'persistImportMemory',
  ]) {
    assert.ok(storeSource.includes(name), `store references ${name}`);
    assert.ok(delegateCode.includes(name), `writer defines ${name}`);
  }
});

test('#2129: no SQL stays in the store facade', () => {
  for (const banned of [
    'CREATE TABLE',
    'CREATE INDEX',
    'upsertMemory',
    'insertEvent',
    'insertLink',
    '.prepare(`',
  ]) {
    assert.ok(!storeSource.includes(banned), `store must not contain ${banned}`);
  }
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'writer has no cycle back into memory-store');
});

test('#2129: writer round-trips every mutation through SQLite', () => {
  delete require.cache[require.resolve('../lib/memory-store')];
  const MemoryStore = require('../lib/memory-store');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2129-'));
  const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 's.db') });

  const stored = store.store({ content: 'writer delegation' });
  assert.equal(stored.ok, true);
  const patched = store.patchMetadata(stored.memory.memoryId, { k: 'v' });
  assert.equal(patched.ok, true);
  const linked = store.store({ content: 'second' });
  const linkRes = store.linkMemories({ fromMemoryId: stored.memory.memoryId, toMemoryId: linked.memory.memoryId, relation: 'related_to' });
  assert.equal(linkRes.ok, true);
  assert.equal(store.queryLinks({}).total, 1);
  const sup = store.supersede(stored.memory.memoryId, 'v2');
  assert.equal(sup.ok, true);
  const tomb = store.tombstone(linked.memory.memoryId);
  assert.equal(tomb.ok, true);

  const fresh = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 's.db') });
  assert.equal(fresh.get(sup.newMemory.memoryId).ok, true);
  assert.equal(fresh.get(linked.memory.memoryId).memory.status, 'deleted');
  assert.ok(fresh.timeline({}).total >= 5);
  store.close();
  fresh.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#3492: persistSupersede stores the hash, and null when a record carries none', () => {
  const MemoryStore = require('../lib/memory-store');
  const { persistSupersede } = require('../lib/memory-store-sqlite-writer');
  const { getContentHash } = require('../lib/memory-store-utils');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-3492-'));
  const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 's.db') });

  const base = {
    workspaceId: 'ws-3492',
    kind: 'memory-record',
    status: 'active',
    metadata: {},
    provenance: { provenanceId: 'p', sourceRef: 'r', sourceTitle: 'T', sourceType: 'api', actor: 'a', timestamp: '2026-06-03T00:00:00.000Z', workspaceId: 'ws-3492', trustPolicyVersion: '1.0.0', confidence: 1 },
    trustPolicyVersion: '1.0.0',
    createdAt: '2026-06-03T00:00:00.000Z',
  };
  const oldRecord = { ...base, memoryId: 'mem-old', content: { text: 'old' } };
  // No supersedesMemoryId/supersedesHash: the writer's `|| null` fallback must
  // store NULL rather than the string 'undefined'.
  const bareRecord = { ...base, memoryId: 'mem-bare', content: { text: 'bare' } };
  const hashedRecord = { ...base, memoryId: 'mem-hashed', content: { text: 'new' }, supersedesMemoryId: 'mem-old', supersedesHash: 'deadbeef' };

  const event = (memoryId, suffix = '') => ({
    workspaceId: 'ws-3492', eventId: `evt-${memoryId}${suffix}`, eventType: 'CREATED', memoryId, actor: 'a',
    details: {}, provenance: base.provenance, trustPolicyVersion: '1.0.0', createdAt: base.createdAt,
  });
  const link = (fromMemoryId) => ({
    workspaceId: 'ws-3492', linkId: `link-${fromMemoryId}`, relation: 'supersedes', fromMemoryId, toMemoryId: 'mem-old',
    strength: 1, provenance: base.provenance, trustPolicyVersion: '1.0.0', createdAt: base.createdAt, metadata: {},
    supersedesHash: 'deadbeef', newContentHash: 'cafef00d',
  });
  

  persistSupersede(store, {
    newRecord: bareRecord, oldRecord, link: link('mem-bare'), event: event('mem-bare'), oldMemoryUpdateEvent: event('mem-old', '-a'), getContentHash,
  });
  persistSupersede(store, {
    newRecord: hashedRecord, oldRecord, link: link('mem-hashed'), event: event('mem-hashed'), oldMemoryUpdateEvent: event('mem-old', '-b'), getContentHash,
  });

  const fresh = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 's.db') });
  const bare = fresh.get('mem-bare', { workspaceId: 'ws-3492' });
  assert.equal(bare.ok, true);
  assert.equal(bare.memory.supersedesMemoryId, undefined, 'an absent supersede id reads back as absent, not a string');
  assert.equal(bare.memory.supersedesHash, undefined);
  const hashed = fresh.get('mem-hashed', { workspaceId: 'ws-3492' });
  assert.equal(hashed.memory.supersedesMemoryId, 'mem-old');
  assert.equal(hashed.memory.supersedesHash, 'deadbeef');

  store.close();
  fresh.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
