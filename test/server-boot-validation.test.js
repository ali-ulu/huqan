'use strict';

// Production Gate A item 6 (#2366): missing startup configuration must stop
// the boot with a specific message, not produce a half-working server.
//
// Unit cases exercise the pure validator directly. The boot-path case spawns
// the real server entry without a key and asserts the deliberate exit.
// (Keyed boots are covered by test/server-graceful-shutdown.test.js, which
// asserts 200 + clean shutdown; top-level intervals keep a DISABLE_AUTO_LISTEN
// probe alive by design, so no exit-0 spawn assertion belongs here.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { requireApiKeyAtBoot } = require('../lib/http/boot-validation');

const SERVER = path.join(__dirname, '..', 'server.js');

test('missing key throws HUQAN_API_KEY_REQUIRED with a specific message', () => {
  assert.throws(() => requireApiKeyAtBoot({}), (error) => {
    assert.equal(error.code, 'HUQAN_API_KEY_REQUIRED');
    assert.match(error.message, /HUQAN_API_KEY.*required/);
    return true;
  });
});

test('canonical key passes validation', () => {
  requireApiKeyAtBoot({ HUQAN_API_KEY: 'k' });
});

test('legacy key passes validation', () => {
  requireApiKeyAtBoot({ AXIOM_API_KEY: 'k' });
});

test('conflicting keys propagate HUQAN_ENV_CONFLICT instead of a quiet choice', () => {
  assert.throws(() => requireApiKeyAtBoot({ HUQAN_API_KEY: 'a', AXIOM_API_KEY: 'b' }), { code: 'HUQAN_ENV_CONFLICT' });
});

test('server boot without an API key stops with HUQAN_API_KEY_REQUIRED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-boot-validation-'));
  try {
    const env = {
      ...process.env,
      HUQAN_MEMORY_PATH: path.join(root, 'memory.json'),
      HUQAN_DB_PATH: path.join(root, 'memory.db'),
      HUQAN_USE_SQLITE: 'false',
      HUQAN_HOST: '127.0.0.1',
      PORT: '0',
    };
    delete env.HUQAN_API_KEY;
    delete env.AXIOM_API_KEY;
    const child = spawnSync(process.execPath, [SERVER], { env, encoding: 'utf8', timeout: 60_000 });
    assert.notEqual(child.status, 0, `expected non-zero exit; stdout=${child.stdout}`);
    assert.match(child.stderr, /HUQAN_API_KEY.*required/, `specific message missing; stderr=${child.stderr}`);
    assert.match(child.stderr, /HUQAN_API_KEY_REQUIRED/, `error code missing; stderr=${child.stderr}`);
    assert.doesNotMatch(child.stdout, /HUQAN web interface/, 'half-working server must not announce itself');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
