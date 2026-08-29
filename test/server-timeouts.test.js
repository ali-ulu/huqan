'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_HTTP_TIMEOUTS, resolveHttpServerTimeouts } = require('../lib/http/server-timeouts');

function reader(values = {}) {
  return (name) => values[name];
}

test('production HTTP timeouts are explicit and bounded', () => {
  assert.deepEqual(resolveHttpServerTimeouts(reader()), DEFAULT_HTTP_TIMEOUTS);
  assert.ok(DEFAULT_HTTP_TIMEOUTS.headersTimeout <= DEFAULT_HTTP_TIMEOUTS.requestTimeout);
  assert.ok(DEFAULT_HTTP_TIMEOUTS.connectionsCheckingInterval <= DEFAULT_HTTP_TIMEOUTS.headersTimeout);
});

test('production HTTP timeout overrides preserve the parser deadline invariant', () => {
  assert.deepEqual(resolveHttpServerTimeouts(reader({
    HEADERS_TIMEOUT_MS: '2000',
    REQUEST_TIMEOUT_MS: '3000',
    KEEP_ALIVE_TIMEOUT_MS: '250',
  })), {
    headersTimeout: 2000,
    requestTimeout: 3000,
    keepAliveTimeout: 250,
    connectionsCheckingInterval: 1000,
  });
});

for (const [name, value] of [
  ['HEADERS_TIMEOUT_MS', '0'],
  ['HEADERS_TIMEOUT_MS', 'not-a-number'],
  ['REQUEST_TIMEOUT_MS', '-1'],
  ['KEEP_ALIVE_TIMEOUT_MS', '1.5'],
]) {
  test(`production HTTP timeout rejects unsafe ${name}`, () => {
    assert.throws(() => resolveHttpServerTimeouts(reader({ [name]: value })), (error) => {
      assert.equal(error.code, 'HUQAN_HTTP_TIMEOUT_INVALID');
      assert.equal(error.field, name);
      assert.equal(Object.hasOwn(error, 'rawValue'), false);
      return true;
    });
  });
}

test('header timeout cannot exceed the whole-request timeout', () => {
  assert.throws(() => resolveHttpServerTimeouts(reader({
    HEADERS_TIMEOUT_MS: '4000',
    REQUEST_TIMEOUT_MS: '3000',
  })), { code: 'HUQAN_HTTP_TIMEOUT_INVALID', field: 'HEADERS_TIMEOUT_MS' });
});
