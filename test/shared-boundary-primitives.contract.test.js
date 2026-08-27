'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeText } = require('../lib/text-utils');
const {
  stableStringify,
  sha256Hex,
} = require('../lib/receipt/canonical-receipt');

test('normalizeText folds Turkish case, diacritics, whitespace, and nullish input deterministically', () => {
  assert.equal(normalizeText('  KIRMIZI\t\n İÇE  '), 'kirmizi ice');
  assert.equal(normalizeText('Çalışan ŞÖYLEDİR: GÖĞÜS'), 'calisan soyledir: gogus');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(42), '42');
});

test('stableStringify sorts object keys, preserves array order, and allows shared DAG values', () => {
  const shared = { z: 1, a: 2 };
  assert.equal(
    stableStringify({ right: shared, left: shared, values: [3, 1, 2] }),
    '{"left":{"a":2,"z":1},"right":{"a":2,"z":1},"values":[3,1,2]}',
  );
  assert.equal(
    stableStringify({ b: 2, a: 1 }),
    stableStringify({ a: 1, b: 2 }),
  );
  assert.equal(
    sha256Hex(stableStringify({ b: 2, a: 1 })),
    sha256Hex(stableStringify({ a: 1, b: 2 })),
  );
});

test('stableStringify preserves own __proto__ data and rejects circular references', () => {
  const record = Object.create(null);
  Object.defineProperty(record, '__proto__', {
    value: 'safe',
    enumerable: true,
    writable: true,
    configurable: true,
  });
  assert.equal(stableStringify(record), '{"__proto__":"safe"}');

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => stableStringify(cyclic),
    (error) => error instanceof TypeError && error.message === 'stableStringify: circular reference detected',
  );
});
