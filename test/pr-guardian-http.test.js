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
  assert.equal(resolveRouteAuthPolicy('/api/v2/pr-guardian/reviews', 'GET', { prGuardianRouteEnabled: true }).known, true);
});

test('Review Console shell tracks the API it drives rather than loading unconditionally (#1826)', () => {
  // The shell used to be a static public asset, so it resolved as known even
  // with no backend configured. `authRequired` stayed false in both states,
  // which is why the old single assertion could not have caught this: `known`
  // is the field that carries the readiness claim.
  assert.deepEqual(
    resolveRouteAuthPolicy('/pr-guardian', 'GET', {}),
    { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' },
  );

  const configured = resolveRouteAuthPolicy('/pr-guardian', 'GET', { prGuardianRouteEnabled: true });
  assert.equal(configured.known, true);
  // Still public once configured: the shell holds no workspace or approval
  // data, and every route it calls is operator-token authenticated on its own.
  assert.equal(configured.authRequired, false);
  assert.equal(configured.ruleId, 'pr-guardian-ui');

  // The console and its primary API must not disagree about whether the
  // capability exists, in either direction.
  for (const context of [{}, { prGuardianRouteEnabled: true }]) {
    assert.equal(
      resolveRouteAuthPolicy('/pr-guardian', 'GET', context).known,
      resolveRouteAuthPolicy('/api/v2/pr-guardian/reviews', 'GET', context).known,
      'shell and reviews API disclose the same capability state',
    );
  }
});
