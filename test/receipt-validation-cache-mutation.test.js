'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  GENESIS_PREVIOUS_HASH,
  createReceiptValidationCache,
  normalizeStamp,
} = require('../lib/receipt/receipt-validation-cache');

const HASH = 'a'.repeat(64);

function stamp(overrides = {}) {
  return {
    sourceId: 'graph:a',
    workspaceId: 'workspace-a',
    schemaFamily: 'v4',
    receiptId: 'receipt-a',
    generation: 1,
    receiptCount: 1,
    headHash: HASH,
    ...overrides,
  };
}

test('stamp text and integer guards reject each malformed field independently', () => {
  const bad = [
    { sourceId: '' },
    { sourceId: 'x'.repeat(513) },
    { sourceId: 7 },
    { workspaceId: '' },
    { workspaceId: 'x'.repeat(513) },
    { workspaceId: null },
    { schemaFamily: '' },
    { schemaFamily: 'x'.repeat(513) },
    { schemaFamily: {} },
    { receiptId: '' },
    { receiptId: 'x'.repeat(513) },
    { receiptId: [] },
    { generation: -1 },
    { generation: 1.5 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { receiptCount: -1 },
    { receiptCount: 1.5 },
    { receiptCount: Number.MAX_SAFE_INTEGER + 1 },
    { headHash: null },
    { headHash: 'A'.repeat(64) },
    { headHash: 'a'.repeat(63) },
    { headHash: 'g'.repeat(64) },
  ];
  for (const overrides of bad) {
    assert.equal(normalizeStamp(stamp(overrides)), null, JSON.stringify(overrides));
  }
});

test('stamp normalization accepts both legal chain shapes and freezes the result', () => {
  const nonEmpty = normalizeStamp(stamp());
  assert.deepEqual(nonEmpty, stamp());
  assert.equal(Object.isFrozen(nonEmpty), true);

  const empty = normalizeStamp(stamp({
    generation: 0,
    receiptCount: 0,
    headHash: GENESIS_PREVIOUS_HASH,
  }));
  assert.equal(empty.receiptCount, 0);
  assert.equal(empty.generation, 0);
  assert.equal(empty.headHash, GENESIS_PREVIOUS_HASH);
});

test('cache options reject every non-positive, non-integer, and non-object shape', () => {
  for (const options of [
    null,
    [],
    'x',
    { maxEntries: 0 },
    { maxEntries: -1 },
    { maxEntries: 1.5 },
    { maxBytes: 0 },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
  ]) {
    assert.throws(() => createReceiptValidationCache(options));
  }
  const cache = createReceiptValidationCache();
  assert.deepEqual(cache.stats(), {
    entries: 0,
    bytes: 0,
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxBytes: DEFAULT_MAX_BYTES,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
});

test('uncloneable and unserializable values fail closed', () => {
  const cache = createReceiptValidationCache();
  assert.equal(cache.put(stamp(), { fn() {} }), false);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(cache.put(stamp(), cyclic), false);
  assert.equal(cache.stats().entries, 0);
});

test('overwrite and invalidation maintain exact byte and entry accounting', () => {
  const cache = createReceiptValidationCache({ maxEntries: 3, maxBytes: 4096 });
  assert.equal(cache.put(stamp({ sourceId: 'graph:a' }), { value: 'short' }), true);
  const first = cache.stats();
  assert.equal(first.entries, 1);
  assert.ok(first.bytes > 0);

  assert.equal(cache.put(stamp({ sourceId: 'graph:a' }), { value: 'a much longer replacement' }), true);
  const replaced = cache.stats();
  assert.equal(replaced.entries, 1);
  assert.ok(replaced.bytes > first.bytes);

  assert.equal(cache.put(stamp({ sourceId: 'graph:b' }), { value: 'b' }), true);
  assert.equal(cache.invalidateSource('graph:a'), true);
  const invalidated = cache.stats();
  assert.equal(invalidated.entries, 1);
  assert.ok(invalidated.bytes > 0);
  assert.equal(cache.invalidateSource('graph:a'), false);
  assert.equal(cache.invalidateSource('x'.repeat(513)), false);
  assert.equal(cache.invalidateSource(7), false);

  cache.clear();
  assert.deepEqual(cache.stats(), {
    entries: 0,
    bytes: 0,
    maxEntries: 3,
    maxBytes: 4096,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
});

test('reads update LRU order, counters, and return the frozen stored clone', () => {
  const cache = createReceiptValidationCache({ maxEntries: 2, maxBytes: 4096 });
  const a = stamp({ sourceId: 'graph:a' });
  const b = stamp({ sourceId: 'graph:b' });
  const c = stamp({ sourceId: 'graph:c' });

  assert.equal(cache.get(a), null);
  assert.equal(cache.put(a, { nested: { value: 1 } }), true);
  assert.equal(cache.put(b, { nested: { value: 2 } }), true);
  const hit = cache.get(a);
  assert.deepEqual(hit, { nested: { value: 1 } });
  assert.equal(Object.isFrozen(hit), true);
  assert.equal(Object.isFrozen(hit.nested), true);

  assert.equal(cache.put(c, { nested: { value: 3 } }), true);
  assert.equal(cache.get(b), null);
  assert.deepEqual(cache.stats(), {
    entries: 2,
    bytes: cache.stats().bytes,
    maxEntries: 2,
    maxBytes: 4096,
    hits: 1,
    misses: 2,
    evictions: 1,
  });
});
