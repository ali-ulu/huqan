'use strict';

// #3492 (R37): a supersede record carries the content hash of what it
// replaced. `supersedesMemoryId` names the old record; `supersedesHash` names
// its exact bytes, which is the only link that survives the old record being
// gone. These tests pin the hash on the new record, the supersede link, both
// audit events and the receipt, and its survival across a SQLite restart and a
// package export/import round-trip.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const MemoryStore = require('../lib/memory-store');
const { getContentHash } = require('../lib/memory-store-utils');

const WS = 'ws-hash';

function withStore(useSQLite, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-hash-'));
  const open = () => new MemoryStore(useSQLite ? { useSQLite: true, dbPath: path.join(dir, 'memory.db') } : { useSQLite: false });
  const stores = [];
  const track = (store) => { stores.push(store); return store; };
  try {
    return fn(open, track);
  } finally {
    for (const store of stores) store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
}

describe('supersede carries the old and new content hash', () => {
  for (const useSQLite of [false, true]) {
    test(`links both hashes through the receipt on the ${useSQLite ? 'SQLite' : 'in-memory'} store`, () => {
      withStore(useSQLite, (open) => {
        const store = open();
        const old = store.store({ content: 'the first draft', workspaceId: WS }).memory;
        const result = store.supersede(old.memoryId, 'the revised draft', { workspaceId: WS });

        assert.equal(result.ok, true);
        assert.equal(result.supersedesHash, getContentHash('the first draft'));
        assert.equal(result.newContentHash, getContentHash('the revised draft'));
        assert.equal(result.newMemory.supersedesHash, getContentHash('the first draft'));
        assert.equal(result.newMemory.supersedesMemoryId, old.memoryId);
        assert.equal(result.link.supersedesHash, getContentHash('the first draft'));
        assert.equal(result.link.newContentHash, getContentHash('the revised draft'));
        assert.equal(result.event.details.supersedesHash, getContentHash('the first draft'));
        assert.equal(result.oldMemoryUpdateEvent.details.supersedesHash, getContentHash('the first draft'));
        // The new record's own content still hashes to newContentHash; the
        // supersedesHash is the *old* bytes and never the record's own.
        assert.equal(getContentHash(result.newMemory.content), result.newContentHash);
      });
    });
  }

  test('the hashes survive a SQLite restart, so the link outlives the old row', () => {
    withStore(true, (open, track) => {
      const old = track(open()).store({ content: 'v1 body', workspaceId: WS }).memory;
      const result = track(open()).supersede(old.memoryId, 'v2 body', { workspaceId: WS });
      assert.equal(result.ok, true);

      // A fresh store, reading only what the database persisted.
      const reopened = track(open());
      const newRecord = reopened.findById(result.newMemory.memoryId, { workspaceId: WS });
      assert.equal(newRecord.ok, true);
      assert.equal(newRecord.memory.supersedesHash, getContentHash('v1 body'));
      assert.equal(newRecord.memory.supersedesMemoryId, old.memoryId);

      const links = reopened.queryLinks({ workspaceId: WS, relation: 'supersedes', includeTombstoned: true });
      assert.equal(links.ok, true);
      assert.equal(links.total, 1);
      assert.equal(links.links[0].supersedesHash, getContentHash('v1 body'));
      assert.equal(links.links[0].newContentHash, getContentHash('v2 body'));
    });
  });

  test('a supersede with no hash is still valid: the field is optional', () => {
    withStore(false, (open) => {
      const store = open();
      const old = store.store({ content: 'plain', workspaceId: WS }).memory;
      // A record stored directly without a supersedesHash validates and reads
      // back without the field rather than as an empty string.
      const bare = store.store({ content: 'no hash here', workspaceId: WS }).memory;
      assert.equal(bare.supersedesHash, undefined);
      const result = store.supersede(old.memoryId, 'changed', { workspaceId: WS });
      assert.equal(result.ok, true);
      assert.equal(typeof result.supersedesHash, 'string');
    });
  });
});
