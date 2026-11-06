'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gateway = require('../lib/viewer/viewer-gateway');
const primitives = require('../lib/viewer/viewer-gateway-primitives');

test('viewer gateway preserves extracted route constants', () => {
  assert.equal(gateway.VIEWER_PREFIX, primitives.VIEWER_PREFIX);
  assert.equal(gateway.SESSION_PATH, primitives.SESSION_PATH);
  assert.equal(gateway.RECEIPT_PREFIX, primitives.RECEIPT_PREFIX);
});

test('viewer gateway primitives preserve path and secret handling semantics', () => {
  assert.equal(primitives.isViewerPath('/viewer'), true);
  assert.equal(primitives.isViewerPath('/viewer/app.mjs'), true);
  assert.equal(primitives.isViewerPath('/other'), false);

  assert.deepEqual(
    primitives.readReceiptId('/viewer/api/trust-receipt/receipt%201'),
    { ok: true, receiptId: 'receipt 1' },
  );
  assert.deepEqual(
    primitives.readReceiptId('/viewer/api/trust-receipt/'),
    { ok: false },
  );
  assert.equal(primitives.readReceiptId('/other'), null);

  assert.equal(primitives.secureEqual('secret', 'secret'), true);
  assert.equal(primitives.secureEqual('secret', 'other'), false);
});

test('viewer gateway primitives gate the loopback HTTP exception on the socket and Host (#4521)', () => {
  const loopback = { socket: { localAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000' } };
  assert.equal(primitives.useInsecureLoopback(loopback, true), true);
  assert.equal(primitives.useInsecureLoopback(loopback, false), false);

  const proxied = { socket: { localAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000', 'x-forwarded-for': '203.0.113.9' } };
  assert.equal(primitives.useInsecureLoopback(proxied, true), false);

  const forwarded = { socket: { localAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000', forwarded: 'for=203.0.113.9' } };
  assert.equal(primitives.useInsecureLoopback(forwarded, true), false);

  const remote = { socket: { localAddress: '192.168.1.20' }, headers: { host: '127.0.0.1:3000' } };
  assert.equal(primitives.useInsecureLoopback(remote, true), false);

  const rebound = { socket: { localAddress: '127.0.0.1' }, headers: { host: 'attacker.example:3000' } };
  assert.equal(primitives.useInsecureLoopback(rebound, true), false);

  const malformedHost = { socket: { localAddress: '127.0.0.1' }, headers: { host: 'bad host' } };
  assert.equal(primitives.useInsecureLoopback(malformedHost, true), false);

  assert.equal(primitives.useInsecureLoopback({}, true), false);
  assert.equal(primitives.useInsecureLoopback({ socket: null, headers: null }, true), false);
  assert.equal(
    primitives.useInsecureLoopback({ socket: { localAddress: '::1' }, headers: { host: '[::1]:3000' } }, true),
    true,
  );
  assert.equal(
    primitives.useInsecureLoopback({ socket: { localAddress: '127.0.0.1' }, headers: { host: 'localhost:3000' } }, true),
    true,
  );
});
