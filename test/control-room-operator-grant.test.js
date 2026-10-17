'use strict';

// The Control Room's operator grant (ADR-019): ask by default, automatic only
// on a direct loopback request under the legacy authority, and every grant is
// one capability for one decision.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createOperatorGrantRoutes,
  createOperatorGrantBoundary,
  isDirectLoopbackRequest,
} = require('../lib/http/operator-grant-routes');
const { verifyWorkflowDecisionCapability } = require('../lib/http/workflow-decision-gate');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');

const TOKEN = 'operator-token-for-tests-0123456789';
const LOCAL = Object.freeze({ host: '127.0.0.1:3000' });

function tempPreference(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-operator-grant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'grant.json');
}

function harness(t, overrides = {}) {
  const rows = new Map([['approval-1', { id: 'approval-1', status: 'pending' }]]);
  const routes = createOperatorGrantRoutes({
    operatorToken: TOKEN,
    preferencePath: tempPreference(t),
    parseJsonRequest: async (req) => req.body,
    writeJson: (req, res, status, body) => { res.status = status; res.body = body; },
    getApprovalStore: () => ({ getToolApprovalById: (id) => rows.get(id) || null }),
    resolveAuthorityMode: () => ({ mode: 'legacy' }),
    ...overrides,
  });
  async function call(method, pathname, { body, headers = LOCAL, remote = '127.0.0.1' } = {}) {
    const req = { method, body, headers, socket: { remoteAddress: remote } };
    const res = {};
    const handled = await routes.route(req, res, new URL(`http://x${pathname}`));
    assert.equal(handled, true);
    return res;
  }
  return { call, rows };
}

const decision = (extra = {}) => ({ approvalId: 'approval-1', decision: 'approved', reason: '', ...extra });

test('ask is the default: a grant needs the operator key', async (t) => {
  const { call } = harness(t);
  const mode = await call('GET', '/api/v2/operator/grant');
  assert.equal(mode.body.data.mode, 'ask');
  assert.equal(mode.body.data.autoActive, false);

  const missing = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision() });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error.code, 'OPERATOR_AUTH_REQUIRED');

  const wrong = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision({ operatorToken: 'nope' }) });
  assert.equal(wrong.status, 403);
  assert.doesNotMatch(JSON.stringify(wrong.body), new RegExp(TOKEN), 'a refusal never echoes the key');
});

test('a grant is one capability for exactly one decision, verifiable once', async (t) => {
  const { call } = harness(t);
  const res = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', {
    body: decision({ reason: 'checked', operatorToken: TOKEN }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.grantedBy, 'operator');
  const { capability } = res.body.data;
  const nonces = new Map();
  const check = (args) => verifyWorkflowDecisionCapability({ operatorToken: TOKEN, capability, nonceStore: nonces, workspaceId: 'default', ...args });

  assert.equal(check({ approvalId: 'approval-1', decision: 'rejected', reason: 'checked' }), false, 'another verdict is out of scope');
  assert.equal(check({ approvalId: 'approval-2', decision: 'approved', reason: 'checked' }), false, 'another approval is out of scope');
  assert.equal(check({ approvalId: 'approval-1', decision: 'approved', reason: 'other' }), false, 'another reason is out of scope');
  assert.equal(check({ approvalId: 'approval-1', decision: 'approved', reason: 'checked' }), true);
  assert.equal(check({ approvalId: 'approval-1', decision: 'approved', reason: 'checked' }), false, 'a capability is spent on first use');

  const payload = JSON.parse(Buffer.from(capability.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.tool, 'huqan.approve');
  assert.ok(payload.exp - Math.floor(Date.now() / 1000) <= 61, 'valid for at most a minute');
});

test('no grant for an approval that is not pending', async (t) => {
  const { call, rows } = harness(t);
  rows.set('approval-1', { id: 'approval-1', status: 'approved' });
  const res = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision({ operatorToken: TOKEN }) });
  assert.equal(res.status, 404);
});

test('turning automatic approval on needs the operator key; turning it off does not', async (t) => {
  const { call } = harness(t);
  const refused = await call('PUT', '/api/v2/operator/grant', { body: { mode: 'auto' } });
  assert.equal(refused.status, 403);
  const on = await call('PUT', '/api/v2/operator/grant', { body: { mode: 'auto', operatorToken: TOKEN } });
  assert.equal(on.body.data.autoActive, true);

  const auto = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision() });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.data.grantedBy, 'auto');

  const off = await call('PUT', '/api/v2/operator/grant', { body: { mode: 'ask' } });
  assert.equal(off.body.data.mode, 'ask');
  const asked = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision() });
  assert.equal(asked.status, 403);
});

test('automatic approval is never honoured off a direct loopback request', async (t) => {
  const { call } = harness(t);
  await call('PUT', '/api/v2/operator/grant', { body: { mode: 'auto', operatorToken: TOKEN } });
  const cases = [
    ['remote socket', { remote: '192.168.1.20' }],
    ['proxied request', { headers: { ...LOCAL, 'x-forwarded-for': '203.0.113.9' } }],
    ['Forwarded header', { headers: { ...LOCAL, forwarded: 'for=203.0.113.9' } }],
    ['rebound host name', { headers: { host: 'attacker.example:3000' } }],
    ['cross-site browser request', { headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' } }],
    ['foreign origin', { headers: { ...LOCAL, origin: 'http://evil.example' } }],
    ['other local port', { headers: { ...LOCAL, origin: 'http://127.0.0.1:8080' } }],
    ['opaque origin', { headers: { ...LOCAL, origin: 'null' } }],
  ];
  for (const [name, options] of cases) {
    const res = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision(), ...options });
    assert.equal(res.status, 403, `${name} must be asked, not granted automatically`);
  }
  const same = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', {
    body: decision(), headers: { ...LOCAL, origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(same.status, 200, 'the Control Room itself, same origin on loopback, is granted');
});

test('automatic approval cannot be switched on from another computer', async (t) => {
  const { call } = harness(t);
  const res = await call('PUT', '/api/v2/operator/grant', { body: { mode: 'auto', operatorToken: TOKEN }, remote: '10.0.0.4' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'OPERATOR_AUTO_GRANT_UNAVAILABLE');
});

test('an installed approval authority disables automatic approval entirely', async (t) => {
  for (const mode of ['service', 'required_unavailable']) {
    const { call } = harness(t, { resolveAuthorityMode: () => ({ mode }) });
    const refused = await call('PUT', '/api/v2/operator/grant', { body: { mode: 'auto', operatorToken: TOKEN } });
    assert.equal(refused.status, 403, `${mode}: auto cannot be enabled`);
    const state = await call('GET', '/api/v2/operator/grant');
    assert.equal(state.body.data.autoAvailable, false);
  }
  const prefPath = tempPreference(t);
  fs.writeFileSync(prefPath, JSON.stringify({ mode: 'auto' }));
  const { call } = harness(t, { preferencePath: prefPath, resolveAuthorityMode: () => ({ mode: 'service' }) });
  const res = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision() });
  assert.equal(res.status, 403, 'a stored auto preference is ignored once an authority is installed');
});

test('repeated wrong keys lock wrong guesses out, never the operator', async (t) => {
  let now = 1_000_000;
  const { call } = harness(t, { now: () => now });
  for (let i = 0; i < 5; i += 1) {
    await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision({ operatorToken: `guess-${i}` }) });
  }
  const locked = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision({ operatorToken: 'another-guess' }) });
  assert.equal(locked.status, 429, 'wrong guesses still wait out the lockout');
  const right = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision({ operatorToken: TOKEN }) });
  assert.equal(right.status, 200, 'the lock never keeps the operator out');
  const again = await call('POST', '/api/v2/operator/capabilities?workspaceId=default', { body: decision({ operatorToken: 'final-guess' }) });
  assert.equal(again.status, 403, 'the correct key also cleared the guess counter');
});

test('without an operator token the surface does not exist', () => {
  const boundary = createOperatorGrantBoundary({ operatorToken: '' });
  assert.equal(boundary.authContext.operatorGrantRouteEnabled, false);
  for (const p of ['/api/v2/operator/grant', '/api/v2/operator/capabilities']) {
    assert.equal(resolveRouteAuthPolicy(p, 'GET', {}).known, false, `${p} answers 404 when unconfigured`);
    const enabled = resolveRouteAuthPolicy(p, 'POST', { operatorGrantRouteEnabled: true });
    assert.equal(enabled.authRequired, true, `${p} still requires the API key when configured`);
  }
});

test('loopback detection fails closed on ambiguity', () => {
  assert.equal(isDirectLoopbackRequest({ headers: LOCAL, socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isDirectLoopbackRequest({ headers: { host: 'localhost:3000' }, socket: { remoteAddress: '::1' } }), true);
  assert.equal(isDirectLoopbackRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), false, 'no Host header');
  assert.equal(isDirectLoopbackRequest({ headers: LOCAL, socket: {} }), false, 'no socket address');
  assert.equal(isDirectLoopbackRequest({ headers: { ...LOCAL, 'x-real-ip': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } }), false);
});
