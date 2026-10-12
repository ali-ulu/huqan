'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { status } = require('../bin/huqan-authority');

const PIN = Object.freeze({ port: 47821, keyId: 'abcdef0123456789' });

test('legacy mode reports that only the same OS user protects decisions', async () => {
  const result = await status({ resolveMode: () => ({ mode: 'legacy', boundary: 'same-user' }) });
  assert.equal(result.code, 0);
  assert.deepEqual([result.report.mode, result.report.boundary], ['legacy', 'same-user']);
});

test('service mode with the pinned service answering exits 0', async () => {
  const result = await status({ resolveMode: () => ({ mode: 'service', boundary: 'os-service', pinPath: 'pin', pin: PIN }),
    createClient: () => ({ identity: async () => ({ status: 200, body: { keyId: PIN.keyId } }) }) });
  assert.equal(result.code, 0);
  assert.deepEqual([result.report.boundary, result.report.answering], ['os-service', true]);
});

test('an impostor on the port, or no service at all, exits 2 with the reason', async () => {
  for (const code of ['AUTHORITY_IMPERSONATION', 'AUTHORITY_UNAVAILABLE']) {
    const result = await status({ resolveMode: () => ({ mode: 'service', boundary: 'os-service', pinPath: 'pin', pin: PIN }),
      createClient: () => ({ identity: async () => { throw Object.assign(new Error(code), { code }); } }) });
    assert.deepEqual([result.code, result.report.answering, result.report.error], [2, false, code]);
  }
});

test('a required or broken authority exits 2', async () => {
  const result = await status({ resolveMode: () => ({ mode: 'required_unavailable', reason: 'pin_malformed', pinPath: 'pin' }) });
  assert.deepEqual([result.code, result.report.reason], [2, 'pin_malformed']);
});

test('the installed command prints usage for anything but status', () => {
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'huqan-authority.js'), 'approve'], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /usage: huqan-authority status/);
});

test('a signed answer that is not a 200 under the pinned key is not the pinned service answering', async () => {
  for (const identity of [{ status: 500, body: { code: 'INTERNAL' } }, { status: 200, body: { keyId: 'ffffffffffffffff' } },
    { status: 200, body: null }]) {
    const result = await status({ resolveMode: () => ({ mode: 'service', boundary: 'os-service', pinPath: 'pin', pin: PIN }),
      createClient: () => ({ identity: async () => identity }) });
    assert.deepEqual([result.code, result.report.answering, result.report.error], [2, false, 'AUTHORITY_IDENTITY_MISMATCH']);
  }
});

test('an override pin is reported as chosen by the environment, not as an OS boundary', async () => {
  const result = await status({ resolveMode: () => ({ mode: 'service', boundary: 'env-override', pinPath: 'pin', pin: PIN }),
    createClient: () => ({ identity: async () => ({ status: 200, body: { keyId: PIN.keyId } }) }) });
  assert.equal(result.report.boundary, 'env-override');
});
