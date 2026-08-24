'use strict';

/**
 * Importing the same package twice must leave the same state as importing it
 * once.
 *
 * The memory loop deduplicated on content hash, but events and links did not:
 * `store._events.push(...)` and `store._links.push(...)` ran unconditionally.
 * A second import doubled the audit history and duplicated every link, so
 * findLinkedMemories could return the same neighbour twice and edge counts
 * inflated. On the SQLite path a UNIQUE constraint on event_id/link_id turns
 * that second import into a thrown constraint error that rolls back the whole
 * transaction instead -- a different way to break the same contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');

function seededPackage() {
  const source = new MemoryStore();
  const a = source.store({ content: 'memory-a', workspaceId: 'ws-src' });
  const b = source.store({ content: 'memory-b', workspaceId: 'ws-src' });
  source.linkMemories({
    fromMemoryId: a.memory.memoryId,
    toMemoryId: b.memory.memoryId,
    relation: 'supports',
    workspaceId: 'ws-src',
  });

  const exported = source.exportPackage({ workspaceId: 'ws-src' });
  assert.equal(exported.ok, true);
  return exported.package;
}

function importInto(store, pkg, opts = {}) {
  const result = store.importPackage(pkg, { targetWorkspaceId: 'ws-dst', ...opts });
  assert.equal(result.ok, true, JSON.stringify(result.error || {}, null, 2));
  return result;
}

function stateOf(store) {
  const exported = store.exportPackage({ workspaceId: 'ws-dst' });
  assert.equal(exported.ok, true);
  return {
    memories: exported.package.memories.length,
    events: exported.package.events.length,
    links: exported.package.links.length,
  };
}

test('a second import of the same package changes nothing', () => {
  const pkg = seededPackage();
  const store = new MemoryStore();

  importInto(store, pkg);
  const afterFirst = stateOf(store);
  importInto(store, pkg);
  const afterSecond = stateOf(store);

  assert.deepEqual(afterSecond, afterFirst);
});

test('the second import reports its records as skipped, not imported', () => {
  const pkg = seededPackage();
  const store = new MemoryStore();

  const first = importInto(store, pkg);
  const second = importInto(store, pkg);

  assert.ok(first.imported.events > 0, 'the first import must actually import events');
  assert.ok(first.imported.links > 0, 'the first import must actually import links');
  assert.equal(second.imported.events, 0);
  assert.equal(second.imported.links, 0);
  assert.equal(second.skipped.events, first.imported.events);
  assert.equal(second.skipped.links, first.imported.links);
});

test('no duplicate link survives a repeated import', () => {
  const pkg = seededPackage();
  const store = new MemoryStore();

  importInto(store, pkg);
  importInto(store, pkg);

  const links = store.exportPackage({ workspaceId: 'ws-dst' }).package.links;
  const ids = links.map((link) => link.linkId);
  assert.equal(new Set(ids).size, ids.length, 'every linkId must appear once');
});

test('no duplicate event survives a repeated import', () => {
  const pkg = seededPackage();
  const store = new MemoryStore();

  importInto(store, pkg);
  importInto(store, pkg);

  const events = store.exportPackage({ workspaceId: 'ws-dst' }).package.events;
  const ids = events.map((event) => event.eventId);
  assert.equal(new Set(ids).size, ids.length, 'every eventId must appear once');
});

test('a repeated import in strict mode does not raise a conflict', () => {
  const pkg = seededPackage();
  const store = new MemoryStore();

  importInto(store, pkg, { mode: 'strict' });
  const second = store.importPackage(pkg, { targetWorkspaceId: 'ws-dst', mode: 'strict' });

  assert.equal(second.ok, true, JSON.stringify(second.error || {}, null, 2));
  assert.equal(second.imported.events, 0);
});

test('a genuinely new record in a re-imported package is still imported', () => {
  const pkg = seededPackage();
  const store = new MemoryStore();
  importInto(store, pkg);

  const extended = seededPackage();
  extended.memories = [...pkg.memories, ...extended.memories.slice(0, 1)];
  extended.events = [...pkg.events, ...extended.events.slice(0, 1)];
  const second = importInto(store, extended);

  assert.ok(second.imported.memories >= 1, 'the new memory must land');
  assert.ok(second.skipped.events >= pkg.events.length, 'the repeated events must be skipped');
});
