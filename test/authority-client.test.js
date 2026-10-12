'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { signResponse, keyIdFor } = require('../lib/authority/decision-envelope');

function pinFor(created, port) {
  return parseAuthorityPin(JSON.stringify({ v: 'huqan.authority.pin.v1', port, keyId: keyIdFor(created.signingPublicKeyPem),
    signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem })).pin;
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

async function realAuthority(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authclient-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state') });
  const service = createAuthorityService({ ledger: openLedgerStore({ file: path.join(dir, 'ledger.jsonl') }), state });
  const port = await listen(t, createAuthorityServer({ service, signingKey: state.signingKey }));
  return { created, port };
}

test('the client talks to the pinned authority and returns verified answers', async (t) => {
  const { created, port } = await realAuthority(t);
  const client = createAuthorityClient({ pin: pinFor(created, port) });
  const identity = await client.identity();
  assert.equal(identity.status, 200);
  assert.equal(identity.body.keyId, keyIdFor(created.signingPublicKeyPem));
  assert.deepEqual(await client.getDecision('nope'), { status: 404, body: { code: 'NOT_FOUND' } });
});

test('an impostor signing with its own key is refused', async (t) => {
  const pinned = await realAuthority(t);
  const impostorKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const port = await listen(t, http.createServer((request, response) => {
    const signed = signResponse({ status: 200, body: { status: 'pending' } }, { challenge: request.headers['x-huqan-challenge'],
      method: request.method, path: request.url, requestDigest: crypto.createHash('sha256').update('').digest('hex') }, impostorKey);
    response.end(JSON.stringify(signed));
  }));
  const client = createAuthorityClient({ pin: pinFor(pinned.created, port) });
  await assert.rejects(client.getDecision('apr_1'), { code: 'AUTHORITY_IMPERSONATION' });
});

test('an impostor replaying an answer the real authority gave earlier is refused', async (t) => {
  const { created, port: realPort } = await realAuthority(t);
  let recorded = null;
  const proxyPort = await listen(t, http.createServer((request, response) => {
    if (recorded) return response.end(recorded);
    const upstream = http.request({ host: '127.0.0.1', port: realPort, method: request.method, path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${realPort}` } }, (answer) => {
      let text = '';
      answer.on('data', (c) => { text += c; });
      answer.on('end', () => { recorded = text; response.end(text); });
    });
    request.pipe(upstream);
    return undefined;
  }));
  const client = createAuthorityClient({ pin: pinFor(created, proxyPort) });
  assert.equal((await client.identity()).status, 200, 'a faithful relay is indistinguishable and harmless');
  await assert.rejects(client.identity(), { code: 'AUTHORITY_IMPERSONATION' });
});

test('an unsigned answer and a closed port are told apart', async (t) => {
  const { created } = await realAuthority(t);
  const plainPort = await listen(t, http.createServer((request, response) => response.end('{"status":"pending"}')));
  await assert.rejects(createAuthorityClient({ pin: pinFor(created, plainPort) }).identity(), { code: 'AUTHORITY_IMPERSONATION' });
  const closed = http.createServer();
  const closedPort = await new Promise(resolve => closed.listen(0, '127.0.0.1', () => resolve(closed.address().port)));
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(createAuthorityClient({ pin: pinFor(created, closedPort) }).identity(), { code: 'AUTHORITY_UNAVAILABLE' });
});

test('a dripping impostor is cut off by the overall deadline, and an oversized answer is refused', async (t) => {
  const { created } = await realAuthority(t);
  const drip = await listen(t, http.createServer((request, response) => {
    response.write(' ');
    const timer = setInterval(() => response.write(' '), 50);
    response.on('close', () => clearInterval(timer));
  }));
  const started = Date.now();
  await assert.rejects(createAuthorityClient({ pin: pinFor(created, drip), timeoutMs: 300 }).identity(), { code: 'AUTHORITY_UNAVAILABLE' });
  assert.ok(Date.now() - started < 3000);
  const huge = await listen(t, http.createServer((request, response) => response.end('x'.repeat(2 * 1024 * 1024))));
  await assert.rejects(createAuthorityClient({ pin: pinFor(created, huge) }).identity(), { code: 'AUTHORITY_IMPERSONATION' });
});

test('an answer relayed from another request is refused', async (t) => {
  const { created, port: realPort } = await realAuthority(t);
  const reroute = await listen(t, http.createServer((request, response) => {
    http.get({ host: '127.0.0.1', port: realPort, path: '/v1/ledger/head',
      headers: { host: `127.0.0.1:${realPort}`, 'x-huqan-challenge': request.headers['x-huqan-challenge'] } }, (answer) => {
      answer.pipe(response);
    });
  }));
  await assert.rejects(createAuthorityClient({ pin: pinFor(created, reroute) }).identity(), { code: 'AUTHORITY_IMPERSONATION' });
});

test('approval ids that a server could normalise into another route never leave the client', async (t) => {
  const { created, port } = await realAuthority(t);
  const client = createAuthorityClient({ pin: pinFor(created, port) });
  for (const approvalId of ['..', '.', undefined, 'a/b', 'x'.repeat(129)]) {
    await assert.rejects(Promise.resolve().then(() => client.getDecision(approvalId)), { code: 'INVALID_APPROVAL_ID' }, String(approvalId));
  }
});
