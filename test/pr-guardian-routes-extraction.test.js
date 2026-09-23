'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const routes = require('../lib/http/pr-guardian-routes');
const transport = require('../lib/http/pr-guardian-transport');

test('pr-guardian route facade preserves extracted auth and signature contract', () => {
  assert.equal(routes.operatorAuthorized, transport.operatorAuthorized);
  assert.equal(routes.verifySignature, transport.verifySignature);

  assert.equal(transport.operatorAuthorized('operator-secret', 'operator-secret'), true);
  assert.equal(transport.operatorAuthorized('operator-secret', 'wrong'), false);

  const raw = Buffer.from('{"ok":true}');
  const crypto = require('node:crypto');
  const secret = 'webhook-secret';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(transport.verifySignature(secret, raw, signature), true);
  assert.equal(transport.verifySignature(secret, raw, 'sha256=bad'), false);
});

test('pr-guardian transport exposes the bounded raw-body and header helpers used by webhook routing', () => {
  assert.equal(typeof transport.readRawBody, 'function');
  assert.equal(typeof transport.parseBody, 'function');
  assert.equal(transport.getHeader({ headers: { 'x-test': 'value' } }, 'x-test'), 'value');
  assert.equal(transport.getHeader({ headers: {} }, 'x-test'), '');
});
