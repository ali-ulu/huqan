'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { isPlainObject } = require('../lib/is-plain-object');

test('isPlainObject accepts only ordinary records', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);

  class RecordLike {}
  for (const value of [[], new Date(), /record/, new Map(), new RecordLike(), Object.create({ inherited: true })]) {
    assert.equal(isPlainObject(value), false);
  }
});

test('isPlainObject rejects proxies that throw while reading their prototype', () => {
  const throwingProxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error('prototype access denied');
    },
  });

  assert.equal(isPlainObject(throwingProxy), false);
});

test('isPlainObject rejects revoked proxies without throwing', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  assert.equal(isPlainObject(proxy), false);
});

test('production code defines the predicate only once', () => {
  const libDirectory = path.join(__dirname, '..', 'lib');
  const files = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
  }

  visit(libDirectory);
  const definitions = files
    .filter((file) => /function isPlainObject\s*\(/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(libDirectory, file).replaceAll('\\', '/'));

  assert.deepEqual(definitions, ['is-plain-object.js']);
});
