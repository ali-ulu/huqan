'use strict';

// #2128: the viewer mount (rate limiter + session store + gateway) moved from
// server.js to lib/http/viewer-mount.js. This pins the moved behaviour:
// per-IP cap, window reset, entry eviction, gateway delegation, and reset.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createViewerMount,
  createViewerRateLimiter,
  VIEWER_RATE_LIMIT_WINDOW_MS,
  VIEWER_RATE_LIMIT_MAX,
  VIEWER_RATE_LIMIT_MAX_ENTRIES,
} = require('../lib/http/viewer-mount');
const { createOidcMount } = require('../lib/oidc/mount');
const { createOidcSessionStore } = require('../lib/oidc/session-store');

const reqFrom = (ip) => ({ socket: { remoteAddress: ip } });

test('#2128: limiter allows up to the cap then refuses within the window', () => {
  const limiter = createViewerRateLimiter({ max: 3, windowMs: 60_000 });
  const req = reqFrom('10.0.0.1');
  assert.equal(limiter.check(req, 1000), true);
  assert.equal(limiter.check(req, 1001), true);
  assert.equal(limiter.check(req, 1002), true);
  assert.equal(limiter.check(req, 1003), false);
  // Next window admits again.
  assert.equal(limiter.check(req, 61_001), true);
});

test('#2128: limiter isolates callers by IP and evicts expired entries', () => {
  const limiter = createViewerRateLimiter({ max: 1, windowMs: 1000, maxEntries: 2 });
  assert.equal(limiter.check(reqFrom('a'), 0), true);
  assert.equal(limiter.check(reqFrom('b'), 0), true);
  assert.equal(limiter.check(reqFrom('a'), 1), false);
  // Full table with no expired entry refuses the newcomer.
  assert.equal(limiter.check(reqFrom('c'), 1), false);
  // After expiry the table drains and the newcomer is admitted.
  assert.equal(limiter.check(reqFrom('c'), 1001), true);
});

test('#2128: limiter without a socket address still buckets', () => {
  const limiter = createViewerRateLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(limiter.check({}, 0), true);
  assert.equal(limiter.check({}, 1), false);
});

test('#2128: reset clears all buckets', () => {
  const limiter = createViewerRateLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(limiter.check(reqFrom('x'), 0), true);
  assert.equal(limiter.check(reqFrom('x'), 1), false);
  limiter.reset();
  assert.equal(limiter.check(reqFrom('x'), 2), true);
});

test('#2128: defaults match the values server.js used', () => {
  assert.equal(VIEWER_RATE_LIMIT_WINDOW_MS, 60_000);
  assert.equal(VIEWER_RATE_LIMIT_MAX, 120);
  assert.equal(VIEWER_RATE_LIMIT_MAX_ENTRIES, 2048);
});

test('#2128: mount delegates gateway paths and reset', async () => {
  const calls = [];
  const mount = createViewerMount({
    readReceipt: (...args) => { calls.push(args); return null; },
  });
  assert.equal(typeof mount.isViewerPath, 'function');
  assert.equal(typeof mount.handle, 'function');
  assert.equal(typeof mount.checkRateLimit, 'function');
  // A viewer path is recognised the way server.js routed it.
  assert.equal(mount.isViewerPath('/viewer/index.html'), true);
  assert.equal(mount.isViewerPath('/api/audit'), false);
  // Reset does not throw and re-admits a capped caller.
  const req = reqFrom('9.9.9.9');
  for (let i = 0; i < VIEWER_RATE_LIMIT_MAX; i++) mount.checkRateLimit(req, 0);
  assert.equal(mount.checkRateLimit(req, 1), false);
  mount.reset();
  assert.equal(mount.checkRateLimit(req, 2), true);
});

test('#4214: mount recognises SAML paths and routes them ahead of the gateway', async () => {
  // Unconfigured SAML is a no-op router: the mount stays a pure viewer mount,
  // and a SAML-shaped path is not admitted.
  const bare = createViewerMount({ readReceipt: () => null });
  assert.equal(bare.isViewerPath('/saml/login'), false);
  assert.equal(bare.isViewerPath('/viewer/index.html'), true);

  // With an IdP metadata file in the environment the SAML route is live, so the
  // mount admits its paths and answers them before the gateway.
  // Under the real temp path: a hardcoded /tmp is not a valid directory on
  // Windows, so the fixture is created under os.tmpdir() like the other tests.
  const metadataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-viewer-saml-'));
  const { publicKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(path.join(metadataDir, 'metadata.json'), JSON.stringify({
    entityID: 'https://idp.example.test',
    singleSignOnService: [{ binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', location: 'https://idp.example.test/sso' }],
    x509Cert: [publicKey.export({ type: 'spki', format: 'pem' })],
  }));
  const prev = {};
  const env = {
    HUQAN_SAML_IDP_METADATA_PATH: path.join(metadataDir, 'metadata.json'),
    HUQAN_SAML_SP_ENTITY_ID: 'https://sp.example.test',
  };
  try {
    for (const [k, v] of Object.entries(env)) {
      if (Object.hasOwn(process.env, k)) prev[k] = process.env[k];
      process.env[k] = v;
    }
    const calls = [];
    const live = createViewerMount({ readReceipt: (...args) => { calls.push(args); return null; } });
    assert.equal(live.isViewerPath('/saml/login'), true);
    assert.equal(live.isViewerPath('/saml/acs'), true);

    const req = { method: 'GET', url: '/saml/login', socket: { remoteAddress: '1.2.3.4' } };
    const res = {
      statusCode: null,
      headers: null,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end() {},
      write() {},
    };
    const handled = live.handle(req, res, new URL('http://host/saml/login'));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 302);
    assert.equal(calls.length, 0, 'the gateway receipt reader is not consulted for a SAML path');

    // A non-SAML path falls through to the gateway: the SAML branch does not
    // short-circuit, so the gateway (which returns a promise) answers it.
    const viewerRes = {
      statusCode: null,
      writeHead(status) { this.statusCode = status; },
      end() {},
      write() {},
    };
    const fallthrough = live.handle(
      { method: 'GET', url: '/viewer/index.html' },
      viewerRes,
      new URL('http://host/viewer/index.html'),
    );
    assert.notEqual(fallthrough, true, 'a viewer path is not short-circuited by the SAML route');
  } finally {
    for (const k of Object.keys(env)) {
      if (Object.hasOwn(prev, k)) process.env[k] = prev[k];
      else delete process.env[k];
    }
    fs.rmSync(metadataDir, { recursive: true, force: true });
  }
});

test('#4267: mount recognises OIDC paths and routes them ahead of the gateway', async () => {
  // Unconfigured OIDC is a no-op router: the mount stays a pure viewer mount
  // and an OIDC-shaped path is not admitted.
  const bare = createViewerMount({ readReceipt: () => null });
  assert.equal(bare.isViewerPath('/auth/oidc/login'), false);
  assert.equal(bare.oidcMount.configured, false);
  assert.equal(bare.oidcMount.enabled, false);
  // Reset must survive an unconfigured mount (no session store to close) and a
  // store whose close throws, because reset is called on the shutdown path.
  bare.reset();
  createViewerMount({
    readReceipt: () => null,
    oidc: { isOidcPath: () => false, sessionStore: { close() { throw new Error('already closed'); } } },
  }).reset();

  // A configured mount admits its four paths and answers them before the
  // gateway. A `:memory:` session store keeps the test off the filesystem.
  const calls = [];
  const oidc = createOidcMount({
    configResult: {
      ok: true,
      configured: true,
      config: {
        issuer: 'https://idp.example.test/',
        allowedOrigin: 'http://app.example.test',
        apiKeyFallback: false,
        allowInsecureRequests: false,
        sessionDbPath: ':memory:',
        identityMapping: { groupRoles: { 'huqan-approvers': 'approver' } },
      },
    },
    createSessionStore: () => createOidcSessionStore({ dbPath: ':memory:' }),
    rbacPolicy: { roles: { approver: {} } },
  });
  const live = createViewerMount({ readReceipt: (...args) => { calls.push(args); return null; }, oidc });
  try {
    for (const path of ['/auth/oidc/login', '/auth/oidc/callback', '/auth/session', '/auth/logout']) {
      assert.equal(live.isViewerPath(path), true, `${path} must be admitted by the mount`);
    }
    assert.equal(live.isViewerPath('/viewer/index.html'), true);

    const req = { method: 'GET', url: '/auth/session', socket: { remoteAddress: '1.2.3.4' } };
    const res = {
      statusCode: null,
      headers: null,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end() {},
      write() {},
    };
    assert.equal(live.handle(req, res, new URL('http://host/auth/session')), true);
    assert.equal(res.statusCode, 401, 'an unauthenticated session read is refused');
    assert.equal(calls.length, 0, 'the gateway receipt reader is not consulted for an OIDC path');
  } finally {
    live.reset();
  }
});

test('#2128: server.js routes viewer traffic through the mount', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("require('./lib/http/viewer-mount')"), 'server requires the viewer mount');
  assert.ok(!source.includes("require('./lib/viewer/session-store')"), 'session-store require moved out');
  assert.ok(!source.includes("require('./lib/viewer/viewer-gateway')"), 'viewer-gateway require moved out');
  assert.ok(!source.includes('checkViewerRateLimit(req)'), 'inline rate check replaced by the mount');
});
