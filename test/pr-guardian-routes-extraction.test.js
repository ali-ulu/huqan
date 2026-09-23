'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const routes = require('../lib/http/pr-guardian-routes');
const auth = require('../lib/http/pr-guardian-auth');
const body = require('../lib/http/pr-guardian-body');

const OPERATOR_TOKEN = 'operator-secret';
const BASE = 'http://127.0.0.1';

test('pr-guardian route facade preserves extracted auth and signature contract', () => {
  assert.equal(routes.operatorAuthorized, auth.operatorAuthorized);
  assert.equal(routes.verifySignature, auth.verifySignature);

  assert.equal(auth.operatorAuthorized(OPERATOR_TOKEN, OPERATOR_TOKEN), true);
  assert.equal(auth.operatorAuthorized(OPERATOR_TOKEN, 'wrong'), false);

  const raw = Buffer.from('{"ok":true}');
  const secret = 'webhook-secret';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(auth.verifySignature(secret, raw, signature), true);
  assert.equal(auth.verifySignature(secret, raw, 'sha256=bad'), false);
});

test('pr-guardian body module exposes the bounded raw-body and header helpers used by webhook routing', () => {
  assert.equal(typeof body.readRawBody, 'function');
  assert.equal(typeof body.parseBody, 'function');
  assert.equal(body.getHeader({ headers: { 'x-test': 'value' } }, 'x-test'), 'value');
  assert.equal(body.getHeader({ headers: {} }, 'x-test'), '');
});

async function capture(method, pathname, headers = {}) {
  const captured = {};
  const { route } = routes.createPrGuardianRoutes({
    operatorToken: OPERATOR_TOKEN,
    webhookSecret: 'webhook-secret',
    getApprovalStore: () => ({ saveToolApprovalIfAbsent: () => ({}), listUnresolvedToolApprovals: () => [] }),
    parseJsonRequest: async () => ({}),
    writeJson: (req, res, status, payload, responseHeaders) => {
      Object.assign(captured, { status, payload, headers: responseHeaders });
    },
  });
  await route({ method, headers }, {}, new URL(BASE + pathname));
  return captured;
}

// Review data is operator-scoped; no response on these routes may be cached.
for (const [label, method, pathname, headers, status] of [
  ['review list', 'GET', '/api/v2/pr-guardian/reviews', { 'x-huqan-operator-token': OPERATOR_TOKEN }, 200],
  ['operator auth failure', 'GET', '/api/v2/pr-guardian/reviews', {}, 403],
  ['method rejection', 'DELETE', '/api/v2/pr-guardian/reviews', { 'x-huqan-operator-token': OPERATOR_TOKEN }, 405],
]) {
  test(`pr-guardian ${label} response is sent with no-store headers`, async () => {
    const captured = await capture(method, pathname, headers);
    assert.equal(captured.status, status);
    assert.equal(captured.headers?.['Cache-Control'], 'no-store');
    assert.equal(captured.headers?.['X-Content-Type-Options'], 'nosniff');
  });
}
