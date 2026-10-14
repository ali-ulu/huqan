'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadedOutsideBundle, parseOptions, serveAuthority, initAuthority, enrollCheck, PIN_VERSION } = require('../lib/authority/service-main');
const { base32Decode, totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { verifyResponse, requestDigestOf } = require('../lib/authority/decision-envelope');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'lib/authority/service-main.js');
const { NODE_TEST_CONTEXT: _parent, ...CHILD_ENV } = process.env;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authmain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('init writes the pin and an otpauth URI once, and refuses to run again', (t) => {
  const dir = tempDir(t);
  const args = [MAIN, 'init', '--state-dir', path.join(dir, 'state'), '--public-dir', path.join(dir, 'public'), '--port', '47821'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8', env: CHILD_ENV });
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.match(out.otpauthUri, /^otpauth:\/\/totp\//);
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'public', 'authority.json'), 'utf8'));
  assert.deepEqual([pin.v, pin.port, pin.keyId], [PIN_VERSION, 47821, out.keyId]);
  assert.equal(crypto.createPublicKey(pin.sealingKey).asymmetricKeyType, 'x25519');
  const again = spawnSync(process.execPath, args, { encoding: 'utf8', env: CHILD_ENV });
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'public', 'authority.json'), 'utf8')).keyId, out.keyId);
});

test('the bundle check names anything loaded from outside the bundle', () => {
  const inside = [path.join(ROOT, 'lib/authority/totp.js'), path.join(ROOT, 'lib/hash-chain.js')];
  assert.deepEqual(loadedOutsideBundle(inside, ROOT), []);
  assert.deepEqual(loadedOutsideBundle([...inside, path.join(ROOT, 'kernel.js')], ROOT), ['kernel.js']);
});

test('serve refuses to start in a process that has loaded code from outside the bundle', (t) => {
  const dir = tempDir(t);
  // This test process has loaded node:test, the test file and more: exactly
  // the situation of a service started from a user-writable checkout.
  assert.throws(() => serveAuthority({ stateDir: path.join(dir, 'state'), port: 0 }, () => {}),
    /refusing to start: loaded code outside the bundle: .*test\/authority-service-main\.test\.js/);
  assert.equal(fs.existsSync(path.join(dir, 'state')), false, 'nothing was opened or created');
});

test('options are strict', () => {
  assert.throws(() => parseOptions(['--state-dir', 'x', '--port', '70000']), /port/);
  assert.throws(() => parseOptions(['--port', '1']), /state-dir/);
  assert.throws(() => parseOptions(['--state-dir', 'x', '--port', '1', '--eval', 'y']), /unknown/);
});

test('serve starts only from a clean bundle and answers a signed identity', async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, 'state');
  spawnSync(process.execPath, [MAIN, 'init', '--state-dir', stateDir, '--public-dir', path.join(dir, 'public'), '--port', '47821'],
    { env: CHILD_ENV });
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'public', 'authority.json'), 'utf8'));
  const child = spawn(process.execPath, [MAIN, 'serve', '--state-dir', stateDir, '--port', '0'], { env: CHILD_ENV });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let text = '';
    child.stderr.on('data', (chunk) => {
      text += chunk;
      const line = text.split('\n').find(l => l.includes('"listening"'));
      if (line) resolve(JSON.parse(line).port);
      if (text.includes('"fatal"')) reject(new Error(text));
    });
  });
  const challenge = crypto.randomBytes(32).toString('hex');
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/v1/identity', headers: { 'x-huqan-challenge': challenge } }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve(JSON.parse(text)));
    }).on('error', reject);
  });
  const verified = verifyResponse(body, { publicKey: pin.signingKey, challenge, method: 'GET', path: '/v1/identity',
    requestDigest: requestDigestOf('') });
  assert.equal(verified.ok, true);
  assert.equal(verified.body.body.keyId, pin.keyId);
});

test('init refuses port 0 and an existing pin before writing anything', (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, 'state');
  const publicDir = path.join(dir, 'public');
  assert.throws(() => initAuthority({ stateDir, publicDir, port: 0 }), /fixed --port/);
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'authority.json'), '{}');
  assert.throws(() => initAuthority({ stateDir, publicDir, port: 47821 }), /existing/);
  assert.equal(fs.existsSync(stateDir), false, 'no state was created');
});

test('a port already in use is reported as fatal with a failing exit code', async (t) => {
  const dir = tempDir(t);
  const blocker = http.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  spawnSync(process.execPath, [MAIN, 'init', '--state-dir', path.join(dir, 'state'), '--public-dir', path.join(dir, 'public'),
    '--port', String(port)], { env: CHILD_ENV });
  const run = spawnSync(process.execPath, [MAIN, 'serve', '--state-dir', path.join(dir, 'state'), '--port', String(port)],
    { encoding: 'utf8', env: CHILD_ENV, timeout: 15000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /"event":"fatal".*EADDRINUSE/);
});

test('enroll-check accepts the right code once, so the installer can prove enrollment before starting', (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, 'state');
  const created = initAuthority({ stateDir, publicDir: path.join(dir, 'public'), port: 47821 });
  const secret = base32Decode(new URL(created.otpauthUri).searchParams.get('secret'));
  const code = totpAt(secret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS));
  assert.deepEqual(enrollCheck({ stateDir, code }), { ok: true });
  assert.deepEqual(enrollCheck({ stateDir, code }), { ok: false, code: 'TOTP_REPLAYED' });
  assert.deepEqual(enrollCheck({ stateDir, code: '000000' }).ok, false);
});
