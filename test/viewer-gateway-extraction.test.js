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
