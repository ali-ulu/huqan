'use strict';

// #3018: HUQAN_DISABLE_API_AUTH is the one intentional fail-open switch in an
// otherwise fail-closed posture. On a loopback bind it is a deliberate
// single-operator convenience; combined with a non-loopback bind it used to
// produce a fully unauthenticated server behind a single console.warn. The
// unsafe combination is now refused at boot unless the operator sets
// HUQAN_DISABLE_API_AUTH_ALLOW_REMOTE, and doctor surfaces it as a finding.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  enforceApiAuthOptOutPolicy,
  checkApiAuthOptOut,
  isApiAuthDisabled,
  isApiAuthOptOutSet,
  isApiAuthRemoteOptInSet,
  isLoopbackHost,
  resetApiAuthOptOutAnnouncement,
} = require('../lib/api-auth-opt-out');
const { requireApiKey } = require('../requestGuards');
const { requireApiKeyAtBoot } = require('../lib/http/server-boot');
const { prepareContainerEnvironment } = require('../scripts/container-server');

const DISABLE_VAR = 'HUQAN_DISABLE_API_AUTH';
const ALLOW_REMOTE_VAR = 'HUQAN_DISABLE_API_AUTH_ALLOW_REMOTE';

function baseEnv(extra = {}) {
  const platformEnv = Object.fromEntries(
    ['PATH', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'WINDIR']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  return { ...platformEnv, ...extra };
}

function withEnv(extra, run) {
  const touched = [...Object.keys(extra), DISABLE_VAR, ALLOW_REMOTE_VAR];
  const previous = new Map(touched.map((key) => [key, process.env[key]]));
  for (const key of touched) delete process.env[key];
  Object.assign(process.env, extra);
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('loopback detection accepts the loopback spellings and refuses everything else', () => {
  for (const host of ['127.0.0.1', '127.8.8.8', 'localhost', 'LOCALHOST', '::1', '::ffff:127.0.0.1', ' 127.0.0.1 ']) {
    assert.equal(isLoopbackHost(host), true, `${host} must count as loopback`);
  }
  for (const host of ['0.0.0.0', '::', '', '192.168.1.10', 'db.internal', '1270.0.0.1', 'localhost.evil.example']) {
    assert.equal(isLoopbackHost(host), false, `${host} must not count as loopback`);
  }
});

test('an unset HOST resolves to the plain-server loopback default, not an unspecified bind', () => {
  // server.js binds `HOST || 127.0.0.1`, so absence here must be judged by
  // that default. The container bootstrap always writes an explicit host.
  withEnv({ [DISABLE_VAR]: 'true' }, () => {
    assert.equal(enforceApiAuthOptOutPolicy(), undefined);
    assert.equal(checkApiAuthOptOut({}).detail, 'set; loopback bind 127.0.0.1');
  });
});

test('the opt-out alone is still accepted on a loopback bind', () => {
  withEnv({ [DISABLE_VAR]: 'true', HUQAN_HOST: '127.0.0.1' }, () => {
    assert.equal(isApiAuthOptOutSet(), true);
    assert.equal(enforceApiAuthOptOutPolicy(), undefined);
  });
  withEnv({ [DISABLE_VAR]: '1', HUQAN_HOST: 'localhost' }, () => {
    assert.equal(enforceApiAuthOptOutPolicy(), undefined);
  });
  withEnv({ [DISABLE_VAR]: '1', HUQAN_HOST: '::1' }, () => {
    assert.equal(enforceApiAuthOptOutPolicy(), undefined);
  });
});

test('the opt-out on a non-loopback bind is refused at boot with a specific code', () => {
  for (const host of ['0.0.0.0', '192.168.1.10', 'db.internal']) {
    withEnv({ [DISABLE_VAR]: 'true', HUQAN_HOST: host }, () => {
      assert.throws(() => enforceApiAuthOptOutPolicy(), (error) => {
        assert.equal(error.code, 'HUQAN_API_AUTH_OPT_OUT_UNSAFE');
        assert.match(error.message, /only safe on a loopback bind/);
        assert.ok(
          error.message.includes(`the configured bind is ${host}`),
          `message must name the bind ${host}`,
        );
        return true;
      }, `host ${host} must be refused`);
    });
  }
});

test('the explicit remote opt-in accepts the non-loopback combination', () => {
  withEnv({ [DISABLE_VAR]: 'true', [ALLOW_REMOTE_VAR]: 'true', HUQAN_HOST: '0.0.0.0' }, () => {
    assert.equal(isApiAuthRemoteOptInSet(), true);
    assert.equal(enforceApiAuthOptOutPolicy(), undefined);
  });
  withEnv({ [DISABLE_VAR]: 'true', [ALLOW_REMOTE_VAR]: '1', HUQAN_HOST: '0.0.0.0' }, () => {
    assert.equal(enforceApiAuthOptOutPolicy(), undefined);
  });
});

test('non-affirmative values never disable auth or unlock the remote combination', () => {
  for (const value of ['false', '0', '', 'yes', 'no']) {
    withEnv({ [DISABLE_VAR]: value, HUQAN_HOST: '0.0.0.0' }, () => {
      assert.equal(isApiAuthOptOutSet(), false, `value ${JSON.stringify(value)} must not disable auth`);
      assert.equal(enforceApiAuthOptOutPolicy(), undefined);
    });
  }
  withEnv({ [DISABLE_VAR]: 'true', [ALLOW_REMOTE_VAR]: 'yes', HUQAN_HOST: '0.0.0.0' }, () => {
    assert.equal(isApiAuthRemoteOptInSet(), false, 'the remote opt-in must be explicit');
    assert.throws(() => enforceApiAuthOptOutPolicy(), { code: 'HUQAN_API_AUTH_OPT_OUT_UNSAFE' });
  });
});

test('without the boot guard the request path stays fail-closed on a non-loopback bind', () => {
  // Defense in depth: if the boot guard never ran (embedded wiring, tests),
  // the guards must not start serving unauthenticated requests on their own.
  resetApiAuthOptOutAnnouncement();
  withEnv({ [DISABLE_VAR]: 'true', HUQAN_HOST: '0.0.0.0' }, () => {
    const result = requireApiKey({ headers: {} }, 'configured-key');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(isApiAuthDisabled(), false);
  });
});

test('the resolved opt-out still admits anonymous requests on loopback', () => {
  resetApiAuthOptOutAnnouncement();
  withEnv({ [DISABLE_VAR]: 'true', HUQAN_HOST: '127.0.0.1' }, () => {
    assert.equal(requireApiKey({ headers: {} }, 'configured-key').ok, true);
    assert.equal(requireApiKey({ headers: {} }, '').ok, true);
  });
  resetApiAuthOptOutAnnouncement();
  withEnv({ [DISABLE_VAR]: 'true' }, () => {
    // HOST absent -> the plain-server loopback default applies.
    assert.equal(requireApiKey({ headers: {} }, '').ok, true);
  });
});

test('the keyless-boot check still fires after the opt-out policy passes', () => {
  withEnv({ [DISABLE_VAR]: 'true', HUQAN_HOST: '127.0.0.1' }, () => {
    assert.throws(() => requireApiKeyAtBoot({ [DISABLE_VAR]: 'true', HUQAN_HOST: '127.0.0.1' }), { code: 'HUQAN_API_KEY_REQUIRED' });
  });
});

test('requireApiKeyAtBoot refuses the unsafe combination before anything else', () => {
  const environment = baseEnv({
    [DISABLE_VAR]: 'true',
    HUQAN_HOST: '0.0.0.0',
    HUQAN_API_KEY: 'k',
  });
  assert.throws(() => requireApiKeyAtBoot(environment), { code: 'HUQAN_API_AUTH_OPT_OUT_UNSAFE' });
});

test('container bootstrap refuses the opt-out on its default 0.0.0.0 bind', () => {
  const environment = baseEnv({ HUQAN_API_KEY: 'k', [DISABLE_VAR]: 'true' });
  assert.throws(() => prepareContainerEnvironment(environment), (error) => {
    assert.equal(error.code, 'HUQAN_API_AUTH_OPT_OUT_UNSAFE');
    assert.match(error.message, /0\.0\.0\.0/);
    return true;
  });
});

test('container bootstrap keeps its defaults when the remote opt-in is explicit', () => {
  const environment = prepareContainerEnvironment(baseEnv({
    HUQAN_API_KEY: 'k',
    [DISABLE_VAR]: 'true',
    [ALLOW_REMOTE_VAR]: 'true',
  }));
  assert.equal(environment.HUQAN_HOST, '0.0.0.0');
});

test('doctor reports the unsafe combination as a failing security finding', () => {
  withEnv({ [DISABLE_VAR]: 'true', HUQAN_HOST: '0.0.0.0' }, () => {
    const result = checkApiAuthOptOut({});
    assert.equal(result.ok, false);
    assert.match(result.detail, /HUQAN_API_AUTH_OPT_OUT_UNSAFE/);
  });
  withEnv({ [DISABLE_VAR]: 'true', HUQAN_HOST: '127.0.0.1' }, () => {
    assert.equal(checkApiAuthOptOut({}).ok, true);
  });
  withEnv({ [DISABLE_VAR]: 'true', [ALLOW_REMOTE_VAR]: '1', HUQAN_HOST: '0.0.0.0' }, () => {
    const result = checkApiAuthOptOut({});
    assert.equal(result.ok, true);
    assert.match(result.detail, /ALLOW_REMOTE/);
  });
  withEnv({}, () => {
    const result = checkApiAuthOptOut({});
    assert.equal(result.ok, true);
    assert.equal(result.detail, 'not set');
  });
});

function spawnBoot(relativePath, envExtra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-opt-out-boot-'));
  try {
    const env = {
      ...baseEnv({
        HUQAN_MEMORY_PATH: path.join(root, 'memory.json'),
        HUQAN_DB_PATH: path.join(root, 'memory.db'),
        HUQAN_USE_SQLITE: 'false',
        PORT: '0',
      }),
      ...envExtra,
    };
    return spawnSync(process.execPath, [path.join(__dirname, '..', relativePath)], { env, encoding: 'utf8', timeout: 60_000 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('server boot with the opt-out on 0.0.0.0 exits before announcing the server', () => {
  const child = spawnBoot('server.js', {
    [DISABLE_VAR]: 'true',
    HUQAN_HOST: '0.0.0.0',
    HUQAN_API_KEY: 'k',
  });
  assert.notEqual(child.status, 0, `expected non-zero exit; stdout=${child.stdout}`);
  assert.match(child.stderr, /only safe on a loopback bind/, `specific message missing; stderr=${child.stderr}`);
  assert.match(child.stderr, /HUQAN_API_AUTH_OPT_OUT_UNSAFE/, `error code missing; stderr=${child.stderr}`);
  assert.doesNotMatch(child.stdout, /HUQAN web interface/, 'an unauthenticated server must not come up');
});

test('container boot with the opt-out on the default bind exits before requiring the server', () => {
  const child = spawnBoot(path.join('scripts', 'container-server.js'), {
    [DISABLE_VAR]: 'true',
    HUQAN_API_KEY: 'k',
  });
  assert.notEqual(child.status, 0, `expected non-zero exit; stdout=${child.stdout}`);
  assert.match(child.stderr, /only safe on a loopback bind/, `specific message missing; stderr=${child.stderr}`);
  assert.doesNotMatch(child.stderr, /Cannot find module/, 'the failure must be the policy, not a wiring error');
});

// Deliberately no exit-0 spawn case here: with DISABLE_AUTO_LISTEN=1 the
// server's top-level intervals keep the probe alive by design (see
// test/server-boot-validation.test.js), so the loopback success path is
// covered by the unit assertions on requireApiKeyAtBoot above.
