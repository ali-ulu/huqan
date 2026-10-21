'use strict';

// The Unix domain socket transport for the approval authority (#4170, #4082 Q5).
//
// TCP on 127.0.0.1 is reachable by every local user and verifies no caller
// identity (ADR-020 section 13, non-claim "the caller's uid is not verified").
// A 0660 socket carries the same bytes over a channel only its owner and a
// named group can open, which narrows who can flood the port. It does not stop
// a same-uid agent: the agent is in that group by construction, which is what
// Layer B (`os-user`) exists for, and the non-claim says so.
//
// Every case here runs the real transport in-process: a real socket under the
// test's own temp directory, the real server and the real client. The install
// side -- creating the group, the directory and the pin field -- is a separate
// change.

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
const { createAuthorityServer, secureSocket, clearStaleSocket, assertSocketPathSafe, SOCKET_MODE } = require('../lib/authority/http-server');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { verifyResponse, requestDigestOf, keyIdFor } = require('../lib/authority/decision-envelope');

const POSIX_ONLY = process.platform === 'win32' && 'a unix socket needs a POSIX host';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-uds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function socketFor(dir, name = 'authority.sock') {
  // A short path: sun_path is capped near 104 bytes and macOS enforces it.
  return path.join(dir, name);
}

function realAuthority(t, socketPath) {
  const dir = tempDir(t);
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state') });
  const service = createAuthorityService({ ledger: openLedgerStore({ file: path.join(dir, 'ledger.jsonl') }), state });
  const server = createAuthorityServer({ service, signingKey: state.signingKey });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try {
        secureSocket(socketPath);
        t.after(() => new Promise(done => server.close(() => done())));
        resolve({ created, server, publicKey: crypto.createPublicKey(created.signingPublicKeyPem) });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function pinFor(created, socketPath) {
  return parseAuthorityPin(JSON.stringify({ v: 'huqan.authority.pin.v1', port: 47821,
    keyId: keyIdFor(created.signingPublicKeyPem), signingKey: created.signingPublicKeyPem,
    sealingKey: created.sealingPublicKeyPem, socketPath })).pin;
}

function rawRequest(socketPath, { method = 'GET', target = '/v1/identity', headers = {}, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path: target, headers: {
      host: 'localhost', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers,
    } }, (response) => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, json: text ? JSON.parse(text) : null, payload }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('the authority answers a signed identity over a unix socket', { skip: POSIX_ONLY }, async (t) => {
  const dir = tempDir(t);
  const socketPath = socketFor(dir);
  const { created, publicKey } = await realAuthority(t, socketPath);
  const challenge = crypto.randomBytes(32).toString('hex');
  const answer = await rawRequest(socketPath, { headers: { 'x-huqan-challenge': challenge } });
  assert.equal(answer.status, 200);
  const verified = verifyResponse(answer.json, { publicKey, challenge, method: 'GET', path: '/v1/identity',
    requestDigest: requestDigestOf('') });
  assert.equal(verified.ok, true);
  assert.equal(verified.body.body.keyId, keyIdFor(created.signingPublicKeyPem));
});

test('a socket is created 0660, and a looser mode is corrected before it is trusted', { skip: POSIX_ONLY }, (t) => {
  const dir = tempDir(t);
  const socketPath = socketFor(dir);
  const server = http.createServer(() => {});
  return new Promise((resolve, reject) => {
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o777);
        assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o777);
        secureSocket(socketPath);
        assert.equal(fs.lstatSync(socketPath).mode & 0o777, SOCKET_MODE, 'the socket must end up 0660');
        server.close(() => resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
});

test('a socket whose mode cannot be closed is refused rather than trusted', { skip: POSIX_ONLY }, (t) => {
  const dir = tempDir(t);
  const socketPath = socketFor(dir);
  const server = http.createServer(() => {});
  return new Promise((resolve, reject) => {
    server.listen(socketPath, () => {
      try {
        // chmod that silently does nothing: the re-read must catch it.
        assert.throws(() => secureSocket(socketPath, { chmod: () => {} }), /not 660/);
        // A path that is not a socket at all is refused before any chmod.
        const file = socketFor(dir, 'not-a-socket');
        fs.writeFileSync(file, 'x');
        assert.throws(() => secureSocket(file), /not a socket/);
        server.close(() => resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
});

test('the host check follows the transport: localhost on a socket, the authority on a port', { skip: POSIX_ONLY }, async (t) => {
  const dir = tempDir(t);
  const socketPath = socketFor(dir);
  await realAuthority(t, socketPath);
  const ok = await rawRequest(socketPath, { headers: { 'x-huqan-challenge': crypto.randomBytes(32).toString('hex') } });
  assert.equal(ok.status, 200);
  // A request that names a foreign host is still refused over the socket: the
  // Host check survives the transport even though a socket has no DNS to rebind.
  const rebinding = await rawRequest(socketPath, { headers: { host: 'evil.test', 'x-huqan-challenge': crypto.randomBytes(32).toString('hex') } });
  assert.equal(rebinding.status, 421);
});

test('a browser origin is refused over the socket too', { skip: POSIX_ONLY }, async (t) => {
  const dir = tempDir(t);
  const socketPath = socketFor(dir);
  await realAuthority(t, socketPath);
  const browser = await rawRequest(socketPath, { headers: { origin: 'https://evil.test', 'x-huqan-challenge': crypto.randomBytes(32).toString('hex') } });
  assert.equal(browser.status, 403);
});

test('a symlinked or non-socket path is refused, and a stale socket is cleared', () => {
  const calls = [];
  const lstat = (p) => ({ isSymbolicLink: () => p.endsWith('link'), isSocket: () => p.endsWith('sock') });
  assert.throws(() => clearStaleSocket('/run/a/link', { lstat, unlink: p => calls.push(p) }), /symlinked/);
  assert.throws(() => clearStaleSocket('/run/a/file', { lstat, unlink: p => calls.push(p) }), /non-socket/);
  assert.deepEqual(calls, [], 'nothing was unlinked for a refused path');
  clearStaleSocket('/run/a/live.sock', { lstat, unlink: p => calls.push(p) });
  assert.deepEqual(calls, ['/run/a/live.sock'], 'a leftover socket was unlinked so the restart can bind');
  // An absent path is not a finding: the first start has nothing to clear.
  clearStaleSocket('/run/a/missing', { lstat: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }, unlink: p => calls.push(p) });
  assert.deepEqual(calls, ['/run/a/live.sock']);
});

test('a socket path that is not a plain absolute path is refused', () => {
  assert.throws(() => assertSocketPathSafe('relative/authority.sock'), /absolute/);
  assert.throws(() => assertSocketPathSafe('/run/../etc/authority.sock'), /absolute/);
  assert.throws(() => assertSocketPathSafe(''), /absolute/);
  assert.doesNotThrow(() => assertSocketPathSafe('/run/huqan-authority/authority.sock'));
});

test('the client reaches the authority over the pinned socket path', { skip: POSIX_ONLY }, async (t) => {
  const dir = tempDir(t);
  const socketPath = socketFor(dir);
  const { created } = await realAuthority(t, socketPath);
  const client = createAuthorityClient({ pin: pinFor(created, socketPath) });
  const identity = await client.identity();
  assert.equal(identity.status, 200);
  assert.equal(identity.body.keyId, keyIdFor(created.signingPublicKeyPem));
});

test('a pin fails closed on a socket path the server would normalise differently', () => {
  const signing = crypto.generateKeyPairSync('ed25519');
  const sealing = crypto.generateKeyPairSync('x25519');
  const signingKey = signing.publicKey.export({ type: 'spki', format: 'pem' });
  const base = { v: 'huqan.authority.pin.v1', port: 47821, keyId: keyIdFor(signingKey), signingKey,
    sealingKey: sealing.publicKey.export({ type: 'spki', format: 'pem' }) };
  const withSocket = (socketPath) => parseAuthorityPin(JSON.stringify({ ...base, socketPath }));
  assert.equal(withSocket('/run/huqan-authority/authority.sock').ok, true);
  assert.equal(withSocket('/run/huqan-authority/authority.sock').pin.socketPath, '/run/huqan-authority/authority.sock');
  for (const bad of ['relative.sock', '/run/../etc/a.sock', '', 42]) {
    assert.deepEqual(withSocket(bad), { ok: false, reason: 'pin_malformed' }, String(bad));
  }
  // An explicit null reads as "no socket", the same as an absent field.
  assert.equal(withSocket(null).ok, true);
  assert.equal(withSocket(null).pin.socketPath, null);
  // A pin without the field still parses: the socket is opt-in, not a new version.
  assert.equal(parseAuthorityPin(JSON.stringify(base)).ok, true);
  assert.equal(parseAuthorityPin(JSON.stringify(base)).pin.socketPath, null);
});
