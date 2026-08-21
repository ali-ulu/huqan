'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { operatorAuthorized, verifySignature } = require('../lib/http/pr-guardian-routes');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');

test('PR Guardian operator authorization is constant-time and rejects missing/mismatched tokens', () => {
  assert.equal(operatorAuthorized('operator-secret', 'operator-secret'), true);
  assert.equal(operatorAuthorized('operator-secret', 'operator-secreT'), false);
  assert.equal(operatorAuthorized('operator-secret', ''), false);
  assert.equal(operatorAuthorized('', 'operator-secret'), false);
});

test('GitHub webhook signature is verified over raw body', () => {
  const secret = 'webhook-secret';
  const body = Buffer.from('{"action":"opened"}');
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifySignature(secret, body, signature), true);
  assert.equal(verifySignature(secret, Buffer.from('{"action":"closed"}'), signature), false);
  assert.equal(verifySignature(secret, body, ''), false);
});

test('PR Guardian route policy is fail-closed when unconfigured and split for webhook HMAC', () => {
  assert.deepEqual(resolveRouteAuthPolicy('/api/v2/pr-guardian/reviews', 'GET', {}), { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' });
  assert.equal(resolveRouteAuthPolicy('/api/v2/pr-guardian/reviews', 'GET', { prGuardianRouteEnabled: true }).authRequired, true);
  assert.equal(resolveRouteAuthPolicy('/api/v2/pr-guardian/reviews/a/decision', 'POST', { prGuardianRouteEnabled: true }).known, true);
  assert.equal(resolveRouteAuthPolicy('/api/v2/pr-guardian/webhooks/github', 'POST', { prGuardianWebhookEnabled: true }).authRequired, false);
  assert.equal(resolveRouteAuthPolicy('/pr-guardian', 'GET', {}).authRequired, false);
  assert.equal(resolveRouteAuthPolicy('/api/v2/pr-guardian/reviews', 'GET', { prGuardianRouteEnabled: true }).known, true);
});
