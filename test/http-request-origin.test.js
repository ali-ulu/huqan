'use strict';

/**
 * Unit coverage for lib/http/request-origin.js.
 *
 * test/production-http-adversarial.test.js proves the behaviour over a real
 * TCP socket, which is the proof that matters; this file pins the decision
 * boundary case by case, where a real socket would be a slow way to ask.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveRequestUrl, FALLBACK_HOST } = require('../lib/http/request-origin');

const request = (host, url = '/health') => ({ url, headers: host === undefined ? {} : { host } });

test('resolves a normal Host into a usable request URL', () => {
  const resolved = resolveRequestUrl(request('127.0.0.1:3000', '/api/audit?limit=5'));
  assert.equal(resolved.pathname, '/api/audit');
  assert.equal(resolved.searchParams.get('limit'), '5');
  assert.equal(resolved.origin, 'http://127.0.0.1:3000');
});

test('accepts every Host shape a real client may legitimately send', () => {
  // Mixed case, an explicit port, a bracketed IPv6 literal, and the trailing
  // root dot are all legal. The check must not be broader than "unusable".
  for (const host of ['EXAMPLE.com:8080', '[::1]:3000', 'example.com.', 'my_host:80', 'localhost']) {
    assert.notEqual(resolveRequestUrl(request(host)), null, `Host: ${host} must resolve`);
  }
});

test('falls back rather than failing when the Host header is absent or empty', () => {
  // An absent Host is not malformed: HTTP/1.0 clients may omit it, and Node's
  // own parser already answers 400 for an HTTP/1.1 request that does. Failing
  // here instead would move a parser decision into application code.
  for (const req of [request(undefined), request(''), { url: '/health', headers: {} }]) {
    const resolved = resolveRequestUrl(req);
    assert.notEqual(resolved, null);
    assert.equal(resolved.hostname, FALLBACK_HOST);
  }
});

test('refuses a Host that the URL parser cannot parse at all', () => {
  // The reported case (#1729): this threw ERR_INVALID_URL out of the request
  // handler and was answered as an internal server fault.
  assert.equal(resolveRequestUrl(request('[bad')), null);
  assert.equal(resolveRequestUrl(request('ex ample.com')), null);
});

test('refuses a Host that parses but relocates the origin', () => {
  // Each of these is accepted by `new URL()` and each yields an origin the
  // client chose rather than the one it sent:
  //   user@evil.com -> http://evil.com   (credentials)
  //   a/b           -> http://a          (path)
  //   a\tb          -> http://ab         (stripped control character)
  for (const host of ['user@evil.com', 'user:pw@evil.com', 'a/b', '127.0.0.1:3000/', 'a\tb', 'a?b', 'a#b']) {
    assert.equal(resolveRequestUrl(request(host)), null, `Host: ${host} must be refused`);
  }
});

test('refuses a request target that cannot be resolved against a good Host', () => {
  // A proxy may send absolute-form (`GET http://… HTTP/1.1`). A broken one
  // throws for the same reason a broken Host does, and earns the same answer.
  assert.equal(resolveRequestUrl(request('127.0.0.1', 'http://[bad/path')), null);
});

test('returns null rather than throwing for a request with no headers at all', () => {
  // Defensive: the caller treats null as "answer the client", so an unusual
  // shape must not become the exception this module exists to prevent.
  assert.notEqual(resolveRequestUrl({ url: '/health' }), null);
  assert.equal(resolveRequestUrl({ url: null, headers: { host: 'a b' } }), null);
});
