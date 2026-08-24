'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  GENESIS_PREVIOUS_HASH,
  createReceiptValidationCache,
  normalizeStamp,
} = require('../lib/receipt/receipt-validation-cache');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function stamp(overrides = {}) {
  return {
    sourceId: 'graph:benchmark',
    workspaceId: 'workspace-a',
    schemaFamily: 'v4',
    receiptId: 'receipt-a',
    generation: 1,
    receiptCount: 1,
    headHash: HASH_A,
    ...overrides,
  };
}

function result() {
  return {
    state: 'valid',
    chain: { valid: true, brokenAt: null, reason: null },
    byReceiptId: { receipt_a: { receiptHash: HASH_A } },
  };
}

test('normalizes a genesis stamp only for an empty receipt chain', () => {
  const normalized = normalizeStamp(stamp({ receiptCount: 0, headHash: GENESIS_PREVIOUS_HASH }));
  assert.equal(normalized.headHash, GENESIS_PREVIOUS_HASH);
  assert.equal(normalizeStamp(stamp({ receiptCount: 0, headHash: HASH_A })), null);
  assert.equal(normalizeStamp(stamp({ receiptCount: 1, headHash: GENESIS_PREVIOUS_HASH })), null);
});

test('returns an immutable value only for an exact stamp match', () => {
  const cache = createReceiptValidationCache();
  const input = result();
  assert.equal(cache.put(stamp(), input), true);
  input.chain.valid = false;

  const hit = cache.get(stamp());
  assert.deepEqual(hit.chain, { valid: true, brokenAt: null, reason: null });
  assert.equal(Object.isFrozen(hit), true);
  assert.equal(Object.isFrozen(hit.chain), true);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 0);
});

test('misses closed when receipt, generation, count, head, workspace, schema, or source changes', () => {
  const cache = createReceiptValidationCache();
  cache.put(stamp(), result());
  for (const changed of [
    { receiptId: 'receipt-b' },
    { generation: 2 },
    { receiptCount: 2, headHash: HASH_B },
    { headHash: HASH_B },
    { workspaceId: 'workspace-b' },
    { schemaFamily: 'v5' },
    { sourceId: 'graph:other' },
  ]) {
    assert.equal(cache.get(stamp(changed)), null);
  }
  assert.equal(cache.stats().hits, 0);
  assert.equal(cache.stats().misses, 7);
});

test('malformed stamps and values bypass storage without throwing', () => {
  const cache = createReceiptValidationCache();
  assert.equal(cache.put({ workspaceId: 'workspace-a' }, result()), false);
  assert.equal(cache.put({ ...stamp(), receiptId: undefined }, result()), false);
  assert.equal(cache.put(stamp(), null), false);
  assert.equal(cache.put(stamp(), 'not-an-object'), false);
  assert.equal(cache.get({ ...stamp(), headHash: 'tampered' }), null);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().misses, 1);
});

test('evicts least-recently-used entries within entry and byte bounds', () => {
  const cache = createReceiptValidationCache({ maxEntries: 2, maxBytes: 1024 });
  assert.equal(cache.put(stamp({ sourceId: 'graph:a' }), result()), true);
  assert.equal(cache.put(stamp({ sourceId: 'graph:b' }), result()), true);
  assert.notEqual(cache.get(stamp({ sourceId: 'graph:a' })), null);
  assert.equal(cache.put(stamp({ sourceId: 'graph:c' }), result()), true);
  assert.equal(cache.get(stamp({ sourceId: 'graph:b' })), null);
  assert.notEqual(cache.get(stamp({ sourceId: 'graph:a' })), null);
  assert.notEqual(cache.get(stamp({ sourceId: 'graph:c' })), null);
  assert.equal(cache.stats().evictions, 1);
});

test('does not retain an oversized validation result', () => {
  const cache = createReceiptValidationCache({ maxBytes: 32 });
  assert.equal(cache.put(stamp(), { state: 'valid', payload: 'x'.repeat(100) }), false);
  assert.equal(cache.get(stamp()), null);
  assert.equal(cache.stats().entries, 0);
});

test('source invalidation and clear remove entries without changing hit accounting', () => {
  const cache = createReceiptValidationCache();
  cache.put(stamp({ sourceId: 'graph:a' }), result());
  cache.put(stamp({ sourceId: 'graph:b' }), result());
  assert.equal(cache.invalidateSource('graph:a'), true);
  assert.equal(cache.get(stamp({ sourceId: 'graph:a' })), null);
  assert.notEqual(cache.get(stamp({ sourceId: 'graph:b' })), null);
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.invalidateSource(''), false);
});
