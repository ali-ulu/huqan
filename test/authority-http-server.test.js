'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { canonicalActionHash } = require('../lib/mcp-operator-capability');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { verifyResponse, requestDigestOf } = require('../lib/authority/decision-envelope');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');

const ARGS = Object.freeze({ content: 'remember this' });
const ACTION = Object.freeze({
  approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn', arguments: ARGS,
  actionHash: canonicalActionHash({ tool: 'huqan.learn', workspaceId: 'default', approvalId: 'apr_1', arguments: ARGS }),
  consumeProofHash: 'a'.repeat(64), summary: 'learn one fact', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authhttp-'));
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state') });
  const service = createAuthorityService({ ledger: openLedgerStore({ file: path.join(dir, 'ledger.jsonl') }), state });
  const server = createAuthorityServer({ service, signingKey: state.signingKey });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); })));
  return { port: server.address().port, created, publicKey: crypto.createPublicKey(created.signingPublicKeyPem) };
}

function send(port, { method = 'GET', path: target, body, headers = {} }) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: target, headers: {
      host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers,
    } }, (response) => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, json: text ? JSON.parse(text) : null, payload }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function signedCall(server, options) {
  const challenge = crypto.randomBytes(32).toString('hex');
  const result = await send(server.port, { ...options, headers: { 'x-huqan-challenge': challenge, ...options.headers } });
  const verified = verifyResponse(result.json, { publicKey: server.publicKey, challenge, method: options.method || 'GET',
    path: options.path, requestDigest: requestDigestOf(result.payload) });
  return { ...result, verified };
}

test('every answer is signed over the challenge and request, with the status inside the signature', async (t) => {
  const server = await startServer(t);
  const identity = await signedCall(server, { path: '/v1/identity' });
  assert.equal(identity.status, 200);
  assert.equal(identity.verified.ok, true);
  assert.equal(identity.verified.body.status, 200);
  const registered = await signedCall(server, { method: 'POST', path: '/v1/approvals', body: ACTION });
  assert.deepEqual([registered.status, registered.verified.body.status], [201, 201]);
  const missing = await signedCall(server, { path: '/v1/approvals/nope/decision' });
  assert.deepEqual([missing.status, missing.verified.body.body.code], [404, 'NOT_FOUND']);
  assert.equal(identity.headers['access-control-allow-origin'], undefined);
  assert.equal(identity.headers['cache-control'], 'no-store');
});

test('a decision taken over HTTP with a sealed code comes back as a signed envelope', async (t) => {
  const server = await startServer(t);
  await signedCall(server, { method: 'POST', path: '/v1/approvals', body: ACTION });
  const totp = totpAt(server.created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS));
  const sealed = sealDecisionRequest({ approvalId: 'apr_1', actionHash: ACTION.actionHash, decision: 'approved', reason: '', totp },
    server.created.sealingPublicKeyPem);
  const decided = await signedCall(server, { method: 'POST', path: '/v1/approvals/apr_1/decision', body: { sealed } });
  assert.equal(decided.status, 200);
  assert.equal(decided.verified.body.body.envelope.payload.decision, 'approved');
});

test('requests from a browser or through another host name are refused', async (t) => {
  const server = await startServer(t);
  const challenge = crypto.randomBytes(32).toString('hex');
  const rebound = await send(server.port, { path: '/v1/identity', headers: { host: `evil.test:${server.port}`, 'x-huqan-challenge': challenge } });
  assert.equal(rebound.status, 421);
  const browser = await send(server.port, { path: '/v1/identity', headers: { origin: 'https://evil.test', 'x-huqan-challenge': challenge } });
  assert.equal(browser.status, 403);
  const unchallenged = await send(server.port, { path: '/v1/identity' });
  assert.equal(unchallenged.status, 400);
});

test('oversized, non-JSON and unknown requests are refused without reaching the service', async (t) => {
  const server = await startServer(t);
  const big = await signedCall(server, { method: 'POST', path: '/v1/approvals', body: { blob: 'x'.repeat(40 * 1024) } });
  assert.equal(big.status, 413);
  const challenge = crypto.randomBytes(32).toString('hex');
  const text = await send(server.port, { method: 'POST', path: '/v1/approvals', body: ACTION,
    headers: { 'content-type': 'text/plain', 'x-huqan-challenge': challenge } });
  assert.equal(text.status, 415);
  const unknown = await signedCall(server, { path: '/v1/nothing' });
  assert.equal(unknown.status, 404);
  const head = await signedCall(server, { path: '/v1/ledger/head' });
  assert.equal(head.verified.body.body.seq, -1, 'none of the refused requests was recorded');
});

test('a client that aborts mid-body leaves no request hanging, and the server keeps answering', async (t) => {
  const server = await startServer(t);
  await new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port: server.port, method: 'POST', path: '/v1/approvals', headers: {
      host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'content-length': 1000,
      'x-huqan-challenge': crypto.randomBytes(32).toString('hex') } });
    request.on('error', () => resolve());
    request.write('{"approvalId":');
    setTimeout(() => { request.destroy(); resolve(); }, 50);
  });
  const identity = await signedCall(server, { path: '/v1/identity' });
  assert.equal(identity.verified.ok, true);
});

test('the server bounds connections and slow requests', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authhttp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createAuthorityState({ dir });
  const state = openAuthorityState({ dir });
  const server = createAuthorityServer({ service: {}, signingKey: state.signingKey });
  assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 10000);
  assert.ok(server.headersTimeout > 0 && server.headersTimeout <= 5000);
  assert.ok(server.maxConnections > 0 && server.maxConnections <= 64);
});

test('a route that throws becomes a 500, not a crashed service', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authhttp-'));
  createAuthorityState({ dir });
  const state = openAuthorityState({ dir });
  const service = { identity: () => { throw new Error('boom'); } };
  const server = createAuthorityServer({ service, signingKey: state.signingKey });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); })));
  const result = await send(server.address().port, { path: '/v1/identity',
    headers: { 'x-huqan-challenge': crypto.randomBytes(32).toString('hex') } });
  assert.equal(result.status, 500);
});
