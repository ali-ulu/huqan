'use strict';

// #4267: the OIDC Relying Party. Every test runs against the loopback mock
// provider in test/helpers/oidc-mock-idp.js, so no test needs Internet access
// and each protocol rejection (state, nonce, PKCE, issuer, audience, signature,
// expiry, group mapping, CSRF, session expiry) is deterministic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadOidcConfig } = require('../lib/oidc/config');
const { mapOidcPrincipal, deriveOperatorId, validateMapping, REFUSED } = require('../lib/oidc/identity-mapping');
const { createOidcSessionStore } = require('../lib/oidc/session-store');
const { createOidcTransactionStore } = require('../lib/oidc/transaction-store');
const { createOidcAuthSeam } = require('../lib/oidc/auth-seam');
const { createOidcClient, classifyGrantError, errorMessages } = require('../lib/oidc/client');
const { createOidcRoute, isAllowedOrigin } = require('../lib/oidc/route');
const { createOidcMount } = require('../lib/oidc/mount');
const { OIDC_FAILURE_CODES } = require('../lib/oidc/failure-codes');
const { buildSetCookie, parseSessionCookie } = require('../lib/oidc/session-cookie');
const { OIDC_PATHS, CSRF_HEADER } = require('../lib/oidc/route-constants');
const { startMockIdp } = require('./helpers/oidc-mock-idp');

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function setEnv(env) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    if (Object.hasOwn(process.env, k)) prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const k of Object.keys(env)) {
      if (Object.hasOwn(prev, k)) process.env[k] = prev[k];
      else delete process.env[k];
    }
  };
}

function writeMapping(dir, issuer, extra = {}) {
  const file = path.join(dir, 'identity-mapping.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    issuer,
    groupsClaim: 'groups',
    operatorIdStrategy: 'issuer-sub-sha256',
    groupRoles: { 'huqan-approvers': 'approver', 'huqan-admins': 'admin' },
    unmappedGroupPolicy: 'deny',
    roleConflictPolicy: 'deny',
    ...extra,
  }));
  return file;
}

function baseEnv(idp, dir, mappingFile, extra = {}) {
  return {
    HUQAN_OIDC_ISSUER: `${idp.issuer}/`,
    HUQAN_OIDC_CLIENT_ID: 'huqan-rp',
    HUQAN_OIDC_CLIENT_SECRET: 'shhh',
    HUQAN_OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/auth/oidc/callback',
    HUQAN_OIDC_IDENTITY_MAPPING_PATH: mappingFile || writeMapping(dir, `${idp.issuer}/`),
    HUQAN_OIDC_SESSION_DB_PATH: path.join(dir, 'sessions.db'),
    HUQAN_OIDC_ALLOWED_ORIGIN: 'http://127.0.0.1:3000',
    HUQAN_OIDC_INSECURE_LOOPBACK: '1',
    ...extra,
  };
}

/** A response recorder: enough of ServerResponse for the route's writes. */
function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    end(chunk) { if (chunk) this.body += chunk; },
    write(chunk) { if (chunk) this.body += chunk; },
  };
}

/** Drive a real login against the mock provider through the real route. */
async function loginThroughRoute({ idp, route, redirectUri = 'http://127.0.0.1:3000/auth/oidc/callback', groups, sub } = {}) {
  const loginRes = makeRes();
  await route.handle({ method: 'GET', headers: {} }, loginRes, new URL('http://127.0.0.1:3000/auth/oidc/login'));
  const authorization = idp.registerAuthorizationUrl(loginRes.headers.Location);
  const code = idp.issueCode({ clientId: 'huqan-rp', nonce: authorization.nonce, groups, sub });
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', authorization.state);
  const callbackRes = makeRes();
  await route.handle(
    { method: 'GET', headers: { cookie: `huqan-sso=x` } },
    callbackRes,
    callbackUrl,
  );
  return { loginRes, authorization, callbackRes, code };
}

test('#4267: OIDC config', async (t) => {
  await t.test('absent configuration is not an error', () => {
    const result = loadOidcConfig({ readEnvironment: () => undefined });
    assert.deepEqual(result, { configured: false, ok: true });
  });

  await t.test('partial configuration refuses startup', () => {
    const result = loadOidcConfig({
      readEnvironment: (name) => (name === 'OIDC_ISSUER' ? 'https://idp.example.test/' : undefined),
    });
    assert.equal(result.configured, true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /partially configured/);
  });

  await t.test('a plain-HTTP issuer is refused without the loopback override', () => {
    const dir = tmpDir('huqan-oidc-cfg-');
    const env = {
      OIDC_ISSUER: 'http://idp.example.test/',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_REDIRECT_URI: 'https://app.example.test/auth/oidc/callback',
      OIDC_IDENTITY_MAPPING_PATH: writeMapping(dir, 'http://idp.example.test/'),
      OIDC_SESSION_DB_PATH: path.join(dir, 's.db'),
    };
    const result = loadOidcConfig({ readEnvironment: (name) => env[name] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HTTPS/);
  });

  await t.test('the mapping issuer must equal the configured issuer', () => {
    const dir = tmpDir('huqan-oidc-cfg-');
    const env = {
      OIDC_ISSUER: 'https://idp.example.test/',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_REDIRECT_URI: 'https://app.example.test/auth/oidc/callback',
      OIDC_IDENTITY_MAPPING_PATH: writeMapping(dir, 'https://other.example.test/'),
      OIDC_SESSION_DB_PATH: path.join(dir, 's.db'),
    };
    const result = loadOidcConfig({ readEnvironment: (name) => env[name] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /issuer must equal/);
  });

  await t.test('a redirect URI with a query is refused', () => {
    const dir = tmpDir('huqan-oidc-cfg-');
    const env = {
      OIDC_ISSUER: 'https://idp.example.test/',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_REDIRECT_URI: 'https://app.example.test/auth/oidc/callback?next=x',
      OIDC_IDENTITY_MAPPING_PATH: writeMapping(dir, 'https://idp.example.test/'),
      OIDC_SESSION_DB_PATH: path.join(dir, 's.db'),
    };
    const result = loadOidcConfig({ readEnvironment: (name) => env[name] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /query or fragment/);
  });

  await t.test('API-key fallback defaults off', () => {
    const dir = tmpDir('huqan-oidc-cfg-');
    const env = {
      OIDC_ISSUER: 'https://idp.example.test/',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_REDIRECT_URI: 'https://app.example.test/auth/oidc/callback',
      OIDC_IDENTITY_MAPPING_PATH: writeMapping(dir, 'https://idp.example.test/'),
      OIDC_SESSION_DB_PATH: path.join(dir, 's.db'),
    };
    const result = loadOidcConfig({ readEnvironment: (name) => env[name] });
    assert.equal(result.ok, true);
    assert.equal(result.config.apiKeyFallback, false);
  });
});

test('#4267: identity mapping', async (t) => {
  const mapping = {
    version: 1,
    issuer: 'https://idp.example.test/',
    groupsClaim: 'groups',
    operatorIdStrategy: 'issuer-sub-sha256',
    groupRoles: { 'huqan-approvers': 'approver', 'huqan-admins': 'admin' },
    unmappedGroupPolicy: 'deny',
    roleConflictPolicy: 'deny',
  };
  const opts = { mapping, issuer: 'https://idp.example.test/' };

  await t.test('derives the documented operatorId', () => {
    // The literal is pinned on purpose: recomputing it here with the same
    // expression would pass even if the derivation drifted. This is the vector
    // docs/sso.md specifies (issuer + NUL + sub, SHA-256, base64url, `oidc:`
    // prefix), and changing the derivation must change this string.
    assert.equal(
      deriveOperatorId('https://idp.example.test/', 'user-1'),
      'oidc:zRCmX3yj-p9ilMmU_bxiZld_9KSR0h2j8z9cEyJNsww',
    );
    assert.match(deriveOperatorId('https://idp.example.test/', 'user-1'), /^oidc:[A-Za-z0-9_-]{43}$/);
    // A NUL separator is what keeps (issuer, sub) pairs from colliding.
    assert.notEqual(
      deriveOperatorId('https://idp.example.test/', 'user-1'),
      deriveOperatorId('https://idp.example.test/user', '-1'),
    );
  });

  await t.test('maps one group to one role', () => {
    const result = mapOidcPrincipal({ sub: 'user-1', groups: ['huqan-approvers'] }, opts);
    assert.equal(result.ok, true);
    assert.equal(result.principal.role, 'approver');
    assert.equal(result.principal.subject, 'user-1');
  });

  await t.test('denies a missing sub', () => {
    assert.equal(mapOidcPrincipal({ groups: ['huqan-approvers'] }, opts).code, REFUSED.NO_SUBJECT);
  });

  await t.test('denies an unmapped group', () => {
    assert.equal(mapOidcPrincipal({ sub: 'u', groups: ['other'] }, opts).code, REFUSED.MISSING_GROUP);
  });

  await t.test('denies a token with no mapped group', () => {
    assert.equal(mapOidcPrincipal({ sub: 'u', groups: [] }, opts).code, REFUSED.MISSING_GROUP);
  });

  await t.test('denies conflicting role mappings', () => {
    const result = mapOidcPrincipal({ sub: 'u', groups: ['huqan-approvers', 'huqan-admins'] }, opts);
    assert.equal(result.code, REFUSED.ROLE_CONFLICT);
  });

  await t.test('denies an unknown role vocabulary', () => {
    const policy = { configured: true, ok: true, policy: { roles: { viewer: {} } } };
    const result = mapOidcPrincipal({ sub: 'u', groups: ['huqan-approvers'] }, { ...opts, rbacPolicy: policy });
    assert.equal(result.code, REFUSED.UNKNOWN_ROLE);
  });

  await t.test('refuses a configurable subject claim', () => {
    const result = mapOidcPrincipal({ sub: 'u', groups: ['huqan-approvers'] }, {
      ...opts,
      mapping: { ...mapping, subjectClaim: 'email' },
    });
    assert.equal(result.code, REFUSED.UNBOUND_SUBJECT);
  });

  await t.test('denies an oversized group claim', () => {
    const groups = Array.from({ length: 300 }, (_, i) => `g${i}`);
    assert.equal(mapOidcPrincipal({ sub: 'u', groups }, opts).code, REFUSED.OVERSIZED_CLAIM);
  });

  await t.test('denies a non-string group value', () => {
    assert.equal(mapOidcPrincipal({ sub: 'u', groups: [42] }, opts).code, REFUSED.OVERSIZED_CLAIM);
  });

  await t.test('denies an empty or oversized group value', () => {
    assert.equal(mapOidcPrincipal({ sub: 'u', groups: [''] }, opts).code, REFUSED.OVERSIZED_CLAIM);
    assert.equal(mapOidcPrincipal({ sub: 'u', groups: ['g'.repeat(257)] }, opts).code, REFUSED.OVERSIZED_CLAIM);
  });

  await t.test('denies an oversized sub claim', () => {
    assert.equal(mapOidcPrincipal({ sub: 's'.repeat(5000), groups: ['huqan-approvers'] }, opts).code, REFUSED.OVERSIZED_CLAIM);
  });

  await t.test('accepts a single string group claim', () => {
    const result = mapOidcPrincipal({ sub: 'u', groups: 'huqan-approvers' }, opts);
    assert.equal(result.ok, true);
    assert.equal(result.principal.role, 'approver');
  });

  await t.test('a token with no group claim is denied', () => {
    assert.equal(mapOidcPrincipal({ sub: 'u' }, opts).code, REFUSED.MISSING_GROUP);
  });

  await t.test('refuses a malformed mapping', () => {
    assert.equal(validateMapping(null).ok, false);
    assert.equal(validateMapping([]).ok, false);
    assert.equal(validateMapping({ version: 2 }).ok, false);
    assert.equal(validateMapping({ version: 1, operatorIdStrategy: 'other' }).code, REFUSED.UNBOUND_SUBJECT);
    assert.equal(validateMapping({ version: 1, operatorIdStrategy: 'issuer-sub-sha256' }).ok, false);
    assert.equal(validateMapping({
      version: 1, operatorIdStrategy: 'issuer-sub-sha256', groupsClaim: 'g', groupRoles: {}, unmappedGroupPolicy: 'allow',
    }).ok, false);
    assert.equal(validateMapping({
      version: 1, operatorIdStrategy: 'issuer-sub-sha256', groupsClaim: 'g', groupRoles: {}, unmappedGroupPolicy: 'deny', roleConflictPolicy: 'first',
    }).code, REFUSED.ROLE_CONFLICT);
    assert.equal(validateMapping({
      version: 1, operatorIdStrategy: 'issuer-sub-sha256', groupsClaim: 'g', groupRoles: [], unmappedGroupPolicy: 'deny', roleConflictPolicy: 'deny',
    }).ok, false);
  });

  await t.test('denies when no validated claims are supplied', () => {
    assert.equal(mapOidcPrincipal(null, opts).code, REFUSED.NO_SUBJECT);
  });
});

test('#4267: session store', async (t) => {
  await t.test('creates, validates, revokes and rejects CSRF mismatch', () => {
    const store = createOidcSessionStore();
    try {
      const session = store.create({ principal: { operatorId: 'oidc:a', role: 'approver', subject: 'u' } });
      assert.match(session.sessionId, /^[A-Za-z0-9_-]{43}$/);
      assert.match(session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(store.validate(session.sessionId).ok, true);
      assert.equal(store.validate(session.sessionId, { csrfToken: session.csrfToken }).ok, true);
      assert.equal(store.validate(session.sessionId, { csrfToken: 'x'.repeat(43) }).reason, 'csrf_mismatch');
      assert.equal(store.revoke(session.sessionId), true);
      assert.equal(store.validate(session.sessionId).reason, 'unknown');
    } finally {
      store.close();
    }
  });

  await t.test('expires on idle and absolute limits', () => {
    let clock = 1_000_000;
    const store = createOidcSessionStore({ now: () => clock, idleTtlMs: 60_000, absoluteTtlMs: 300_000 });
    try {
      const session = store.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      clock += 59_000;
      assert.equal(store.validate(session.sessionId).ok, true);
      clock += 61_000;
      assert.equal(store.validate(session.sessionId).reason, 'idle_expired');
    } finally {
      store.close();
    }
  });

  await t.test('enforces the absolute lifetime even while active', () => {
    let clock = 0;
    const store = createOidcSessionStore({ now: () => clock, idleTtlMs: 60_000, absoluteTtlMs: 100_000 });
    try {
      const session = store.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      for (let i = 0; i < 4; i += 1) { clock += 20_000; assert.equal(store.validate(session.sessionId).ok, true); }
      clock += 20_000;
      assert.equal(store.validate(session.sessionId).reason, 'absolute_expired');
    } finally {
      store.close();
    }
  });

  await t.test('stores only the session-id hash', () => {
    const store = createOidcSessionStore();
    try {
      const session = store.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      assert.equal(store.hashSessionId(session.sessionId).length, 43);
      assert.notEqual(store.hashSessionId(session.sessionId), session.sessionId);
    } finally {
      store.close();
    }
  });

  await t.test('refuses TTLs above the hard upper bounds', () => {
    assert.throws(() => createOidcSessionStore({ idleTtlMs: 60 * 60 * 1000 }), /no greater than/);
  });

  await t.test('requires a principal and a well-formed random source', () => {
    const store = createOidcSessionStore();
    try {
      assert.throws(() => store.create(), /principal/);
      assert.throws(() => store.create({ principal: { operatorId: 'x' } }), /principal/);
    } finally {
      store.close();
    }
    const bad = createOidcSessionStore({ randomBytes: () => Buffer.alloc(4) });
    try {
      assert.throws(() => bad.create({ principal: { operatorId: 'oidc:a', role: 'approver' } }), /32 bytes/);
    } finally {
      bad.close();
    }
    // A source that always repeats a colliding id is refused rather than
    // silently reusing a session.
    const colliding = createOidcSessionStore({ randomBytes: () => Buffer.alloc(32, 7) });
    try {
      colliding.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      assert.throws(() => colliding.create({ principal: { operatorId: 'oidc:a', role: 'approver' } }), /unique session id/);
    } finally {
      colliding.close();
    }
  });

  await t.test('revoke refuses a malformed id and sweep reports deletions', () => {
    let clock = 0;
    const store = createOidcSessionStore({ now: () => clock, absoluteTtlMs: 1000 });
    try {
      assert.equal(store.revoke('nope'), false);
      store.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      clock += 2000;
      assert.equal(store.sweep(), 1);
    } finally {
      store.close();
    }
  });
});

test('#4267: transaction store is single-use and bounded', () => {
  const store = createOidcTransactionStore();
  const tx = store.begin();
  assert.match(tx.state, /^[A-Za-z0-9_-]{43}$/);
  const consumed = store.consume(tx.state);
  assert.equal(consumed.nonce, tx.nonce);
  assert.equal(consumed.codeVerifier, tx.codeVerifier);
  // A replay finds nothing.
  assert.equal(store.consume(tx.state), null);
  // A malformed state is refused without touching the store.
  assert.equal(store.consume('nope'), null);
});

test('#4267: transaction store expires, evicts and bounds', () => {
  let clock = 0;
  const store = createOidcTransactionStore({ now: () => clock, ttlMs: 1000 });
  const first = store.begin();
  clock += 1500;
  // An expired transaction is consumed but yields nothing.
  assert.equal(store.consume(first.state), null);

  const bounded = createOidcTransactionStore({ now: () => clock, maxTransactions: 2 });
  bounded.begin();
  bounded.begin();
  bounded.begin();
  assert.equal(bounded.size(), 2, 'the oldest transaction is evicted at the cap');
  bounded.reset();
  assert.equal(bounded.size(), 0);
});

test('#4267: mount reports an unusable session store instead of throwing', () => {
  const dir = tmpDir('huqan-oidc-mount-fail-');
  const mount = createOidcMount({
    configResult: {
      configured: true,
      ok: true,
      config: {
        issuer: 'https://idp.example.test/',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://app.example.test/auth/oidc/callback',
        identityMapping: { version: 1 },
        sessionDbPath: path.join(dir, 'sessions.db'),
        allowedOrigin: 'https://app.example.test',
        apiKeyFallback: false,
        allowInsecureRequests: false,
      },
    },
    createSessionStore: () => { throw new Error('disk full'); },
  });
  assert.equal(mount.enabled, false);
  assert.equal(mount.ok, false);
  assert.match(mount.reason, /disk full/);
  assert.equal(mount.handle, undefined);
});

test('#4267: route and seam construction guards', () => {
  const config = {
    configured: true,
    ok: true,
    config: {
      issuer: 'https://idp.example.test/',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'https://app.example.test/auth/oidc/callback',
      identityMapping: { version: 1 },
      sessionDbPath: ':memory:',
      allowedOrigin: 'https://app.example.test',
      apiKeyFallback: false,
      allowInsecureRequests: false,
    },
  };
  assert.throws(() => createOidcRoute(), /config must be configured/);
  assert.throws(() => createOidcRoute({ config: { configured: true, ok: false } }), /config must be configured/);
  assert.throws(() => createOidcRoute({ config }), /OIDC client is required/);
  assert.throws(
    () => createOidcRoute({ config, client: { buildAuthorizationUrl: () => {} } }),
    /sessionStore is required/,
  );
  assert.throws(() => createOidcAuthSeam(), /session store is required/);
});

test('#4267: session cookie', () => {
  const sessionId = 'A'.repeat(43);
  const secure = buildSetCookie({ sessionId, secure: true, maxAgeSeconds: 60 });
  assert.match(secure, /^__Host-huqan-sso=/);
  assert.match(secure, /Secure/);
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /Path=\//);
  assert.ok(!/Domain/.test(secure));
  const insecure = buildSetCookie({ sessionId, secure: false, maxAgeSeconds: 60 });
  assert.match(insecure, /^huqan-sso=/);
  assert.ok(!/__Host-/.test(insecure));

  assert.equal(parseSessionCookie(secure.split('; ')[0], { secure: true }), sessionId);
  assert.equal(parseSessionCookie(`__Host-huqan-sso=${sessionId}; __Host-huqan-sso=${'B'.repeat(43)}`, { secure: true }), '');
  assert.equal(parseSessionCookie('', { secure: true }), '');
  assert.throws(() => buildSetCookie({ sessionId: 'short', secure: true, maxAgeSeconds: 1 }), /32-byte/);
});

test('#4267: auth seam', async (t) => {
  await t.test('accepts a cookie session for a safe method', () => {
    const store = createOidcSessionStore();
    try {
      const session = store.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      const seam = createOidcAuthSeam({ sessionStore: store, apiKeyFallback: false, allowedOrigin: 'http://app.test' });
      const result = seam.authorize({ method: 'GET', headers: { cookie: `__Host-huqan-sso=${session.sessionId}` } });
      assert.equal(result.ok, true);
      assert.equal(result.principal.role, 'approver');
      assert.equal(seam.apiKeyFallback, false);
    } finally {
      store.close();
    }
  });

  await t.test('requires Origin and CSRF for a state change', () => {
    const store = createOidcSessionStore();
    try {
      const session = store.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      const seam = createOidcAuthSeam({ sessionStore: store, allowedOrigin: 'http://app.test' });
      const cookie = `__Host-huqan-sso=${session.sessionId}`;
      assert.equal(seam.authorize({ method: 'POST', headers: { cookie } }).code, OIDC_FAILURE_CODES.CSRF_FAILED);
      assert.equal(seam.authorize({
        method: 'POST',
        headers: { cookie, origin: 'http://evil.test', [CSRF_HEADER]: session.csrfToken },
      }).code, OIDC_FAILURE_CODES.CSRF_FAILED);
      assert.equal(seam.authorize({
        method: 'POST',
        headers: { cookie, origin: 'http://app.test', [CSRF_HEADER]: 'x'.repeat(43) },
      }).code, OIDC_FAILURE_CODES.CSRF_FAILED);
      assert.equal(seam.authorize({
        method: 'POST',
        headers: { cookie, origin: 'http://app.test', [CSRF_HEADER]: session.csrfToken },
      }).ok, true);
    } finally {
      store.close();
    }
  });

  await t.test('returns null when no OIDC cookie is present', () => {
    const store = createOidcSessionStore();
    try {
      const seam = createOidcAuthSeam({ sessionStore: store, allowedOrigin: 'http://app.test' });
      assert.equal(seam.authorize({ method: 'GET', headers: {} }), null);
    } finally {
      store.close();
    }
  });

  await t.test('rejects a revoked session', () => {
    const store = createOidcSessionStore();
    try {
      const session = store.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      const seam = createOidcAuthSeam({ sessionStore: store, allowedOrigin: 'http://app.test' });
      store.revoke(session.sessionId);
      assert.equal(
        seam.authorize({ method: 'GET', headers: { cookie: `__Host-huqan-sso=${session.sessionId}` } }).code,
        OIDC_FAILURE_CODES.SESSION_EXPIRED,
      );
    } finally {
      store.close();
    }
  });

  await t.test('an absent CSRF header is refused, not skipped', () => {
    const store = createOidcSessionStore();
    try {
      const session = store.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      const seam = createOidcAuthSeam({ sessionStore: store, allowedOrigin: 'http://app.test' });
      const result = seam.authorize({
        method: 'POST',
        headers: { cookie: `__Host-huqan-sso=${session.sessionId}`, origin: 'http://app.test' },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, OIDC_FAILURE_CODES.CSRF_FAILED);
    } finally {
      store.close();
    }
  });
});

test('#4267: client error classification', () => {
  const withCause = (message, cause) => Object.assign(new Error(message), { cause });
  assert.equal(classifyGrantError({ error: 'invalid_grant' }), OIDC_FAILURE_CODES.PKCE_FAILED);
  assert.equal(classifyGrantError(withCause('grant failed', new Error('nonce mismatch'))), OIDC_FAILURE_CODES.NONCE_INVALID);
  assert.equal(classifyGrantError(withCause('x', new Error('unexpected "iss" claim value'))), OIDC_FAILURE_CODES.ISSUER_MISMATCH);
  assert.equal(classifyGrantError(withCause('x', new Error('unexpected "aud" claim value'))), OIDC_FAILURE_CODES.AUDIENCE_MISMATCH);
  assert.equal(classifyGrantError(withCause('x', new Error('state parameter mismatch'))), OIDC_FAILURE_CODES.STATE_INVALID);
  assert.equal(classifyGrantError(new Error('something else')), OIDC_FAILURE_CODES.TOKEN_INVALID);
  assert.deepEqual(errorMessages(withCause('a', new Error('b'))), ['a', 'b']);
});

test('#4267: route login, callback, session and logout against the mock provider', async (t) => {
  const idp = await startMockIdp({
    claimsFor: (entry) => ({ nonce: entry.nonce, sub: entry.sub, groups: entry.groups, exp: Math.floor(Date.now() / 1000) + 300 }),
  });
  const dir = tmpDir('huqan-oidc-route-');
  const restore = setEnv(baseEnv(idp, dir));
  t.after(async () => { restore(); await idp.close(); });

  const config = loadOidcConfig();
  assert.equal(config.ok, true, config.reason);

  function makeRoute(overrides = {}) {
    const sessionStore = createOidcSessionStore();
    const route = createOidcRoute({
      config,
      client: createOidcClient(config.config),
      sessionStore,
      rbacPolicy: { configured: false, ok: true },
      secureCookie: false,
      ...overrides,
    });
    return { route, sessionStore };
  }

  await t.test('login redirects to the discovered authorization endpoint with PKCE', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const res = makeRes();
      const handled = await route.handle({ method: 'GET', headers: {} }, res, new URL('http://127.0.0.1:3000/auth/oidc/login'));
      assert.equal(handled, true);
      assert.equal(res.statusCode, 302);
      const url = new URL(res.headers.Location);
      assert.equal(url.origin, idp.issuer);
      assert.equal(url.pathname, '/authorize');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
      assert.match(url.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('callback exchanges the code, sets the cookie and redirects locally', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const { callbackRes, authorization } = await loginThroughRoute({ idp, route });
      assert.equal(callbackRes.statusCode, 302);
      assert.equal(callbackRes.headers.Location, '/viewer');
      const cookie = callbackRes.headers['Set-Cookie'];
      assert.match(cookie, /^huqan-sso=/);
      const sessionId = cookie.split(';')[0].split('=')[1];
      const validation = sessionStore.validate(sessionId);
      assert.equal(validation.ok, true);
      assert.equal(validation.role, 'approver');
      assert.equal(validation.operatorId, deriveOperatorId(`${idp.issuer}/`, 'user-1'));
      assert.ok(authorization.state, 'the state was bound to the transaction');
    } finally {
      sessionStore.close();
    }
  });

  await t.test('callback refuses a replayed state', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const { callbackRes, code, authorization } = await loginThroughRoute({ idp, route });
      assert.equal(callbackRes.statusCode, 302);
      const replay = new URL('http://127.0.0.1:3000/auth/oidc/callback');
      replay.searchParams.set('code', code);
      replay.searchParams.set('state', authorization.state);
      const res = makeRes();
      await route.handle({ method: 'GET', headers: {} }, res, replay);
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error.code, OIDC_FAILURE_CODES.STATE_INVALID);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('callback refuses an unknown state', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const url = new URL('http://127.0.0.1:3000/auth/oidc/callback');
      url.searchParams.set('code', 'x');
      url.searchParams.set('state', 'A'.repeat(43));
      const res = makeRes();
      await route.handle({ method: 'GET', headers: {} }, res, url);
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error.code, OIDC_FAILURE_CODES.STATE_INVALID);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('callback maps a provider error to a refusal', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const url = new URL('http://127.0.0.1:3000/auth/oidc/callback?error=access_denied');
      const res = makeRes();
      await route.handle({ method: 'GET', headers: {} }, res, url);
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.body).error.code, OIDC_FAILURE_CODES.STATE_INVALID);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('callback refuses a nonce mismatch', async () => {
    const mismatched = await startMockIdp({
      claimsFor: () => ({ nonce: 'wrong', sub: 'user-1', groups: ['huqan-approvers'], exp: Math.floor(Date.now() / 1000) + 300 }),
    });
    const dir2 = tmpDir('huqan-oidc-nonce-');
    const restore2 = setEnv(baseEnv(mismatched, dir2));
    try {
      const config2 = loadOidcConfig();
      const sessionStore = createOidcSessionStore();
      const route = createOidcRoute({
        config: config2,
        client: createOidcClient(config2.config),
        sessionStore,
        rbacPolicy: { configured: false, ok: true },
        secureCookie: false,
      });
      const { callbackRes } = await loginThroughRoute({ idp: mismatched, route });
      assert.equal(callbackRes.statusCode, 401);
      assert.equal(JSON.parse(callbackRes.body).error.code, OIDC_FAILURE_CODES.NONCE_INVALID);
      sessionStore.close();
    } finally {
      restore2();
      await mismatched.close();
    }
  });

  await t.test('callback denies an unmapped group', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const { callbackRes } = await loginThroughRoute({ idp, route, groups: ['strangers'] });
      assert.equal(callbackRes.statusCode, 403);
      assert.equal(JSON.parse(callbackRes.body).error.code, OIDC_FAILURE_CODES.CLAIM_MAPPING_DENIED);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('session endpoint returns the minimum identity', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const { callbackRes } = await loginThroughRoute({ idp, route });
      const sessionId = callbackRes.headers['Set-Cookie'].split(';')[0].split('=')[1];
      const res = makeRes();
      await route.handle(
        { method: 'GET', headers: { cookie: `huqan-sso=${sessionId}` } },
        res,
        new URL('http://127.0.0.1:3000/auth/session'),
      );
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.operatorId, deriveOperatorId(`${idp.issuer}/`, 'user-1'));
      assert.equal(body.role, 'approver');
      assert.ok(body.csrfToken);
      assert.ok(!('idToken' in body) && !('accessToken' in body) && !('sessionId' in body));
    } finally {
      sessionStore.close();
    }
  });

  await t.test('session endpoint refuses an expired session', async () => {
    let clock = 1_000_000;
    const sessionStore = createOidcSessionStore({ now: () => clock });
    try {
      const session = sessionStore.create({ principal: { operatorId: 'oidc:a', role: 'approver' } });
      const route = createOidcRoute({
        config,
        client: createOidcClient(config.config),
        sessionStore,
        rbacPolicy: { configured: false, ok: true },
        secureCookie: false,
      });
      clock += 31 * 60_000;
      const res = makeRes();
      await route.handle(
        { method: 'GET', headers: { cookie: `huqan-sso=${session.sessionId}` } },
        res,
        new URL('http://127.0.0.1:3000/auth/session'),
      );
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.body).error.code, OIDC_FAILURE_CODES.SESSION_EXPIRED);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('logout requires Origin and CSRF, then revokes', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const { callbackRes } = await loginThroughRoute({ idp, route });
      const sessionId = callbackRes.headers['Set-Cookie'].split(';')[0].split('=')[1];
      const csrfToken = sessionStore.validate(sessionId).csrfToken;
      const cookie = `huqan-sso=${sessionId}`;

      const noOrigin = makeRes();
      await route.handle({ method: 'POST', headers: { cookie } }, noOrigin, new URL('http://127.0.0.1:3000/auth/logout'));
      assert.equal(noOrigin.statusCode, 403);
      assert.equal(JSON.parse(noOrigin.body).error.code, OIDC_FAILURE_CODES.CSRF_FAILED);

      const badCsrf = makeRes();
      await route.handle(
        { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:3000', [CSRF_HEADER]: 'x'.repeat(43) } },
        badCsrf,
        new URL('http://127.0.0.1:3000/auth/logout'),
      );
      assert.equal(JSON.parse(badCsrf.body).error.code, OIDC_FAILURE_CODES.CSRF_FAILED);

      const ok = makeRes();
      await route.handle(
        { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:3000', [CSRF_HEADER]: csrfToken } },
        ok,
        new URL('http://127.0.0.1:3000/auth/logout'),
      );
      assert.equal(ok.statusCode, 204);
      assert.equal(sessionStore.validate(sessionId).ok, false);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('rejects a wrong method', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const login = makeRes();
      await route.handle({ method: 'POST', headers: {} }, login, new URL('http://127.0.0.1:3000/auth/oidc/login'));
      assert.equal(login.statusCode, 405);
      const callback = makeRes();
      await route.handle({ method: 'POST', headers: {} }, callback, new URL('http://127.0.0.1:3000/auth/oidc/callback'));
      assert.equal(callback.statusCode, 405);
      const session = makeRes();
      await route.handle({ method: 'POST', headers: {} }, session, new URL('http://127.0.0.1:3000/auth/session'));
      assert.equal(session.statusCode, 405);
      const logout = makeRes();
      await route.handle({ method: 'GET', headers: {} }, logout, new URL('http://127.0.0.1:3000/auth/logout'));
      assert.equal(logout.statusCode, 405);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('callback without a code is refused', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const tx = route._transactions.begin();
      const url = new URL('http://127.0.0.1:3000/auth/oidc/callback');
      url.searchParams.set('state', tx.state);
      const res = makeRes();
      await route.handle({ method: 'GET', headers: {} }, res, url);
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error.code, OIDC_FAILURE_CODES.STATE_INVALID);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('session endpoint without a cookie is refused', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      const res = makeRes();
      await route.handle({ method: 'GET', headers: {} }, res, new URL('http://127.0.0.1:3000/auth/session'));
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.body).error.code, OIDC_FAILURE_CODES.SESSION_EXPIRED);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('a provider that cannot be discovered refuses login', async () => {
    const sessionStore = createOidcSessionStore();
    try {
      const route = createOidcRoute({
        config,
        client: {
          calculatePkceChallenge: async () => 'challenge',
          buildAuthorizationUrl: async () => { throw new Error('unreachable'); },
        },
        sessionStore,
        rbacPolicy: { configured: false, ok: true },
        secureCookie: false,
      });
      const res = makeRes();
      await route.handle({ method: 'GET', headers: {} }, res, new URL('http://127.0.0.1:3000/auth/oidc/login'));
      assert.equal(res.statusCode, 503);
      assert.equal(JSON.parse(res.body).error.code, OIDC_FAILURE_CODES.DISCOVERY_FAILED);
    } finally {
      sessionStore.close();
    }
  });

  await t.test('an unrelated path is not handled', async () => {
    const { route, sessionStore } = makeRoute();
    try {
      assert.equal(route.handle({ method: 'GET', headers: {} }, makeRes(), new URL('http://x/nope')), false);
      assert.equal(route.isOidcPath('/auth/oidc/login'), true);
      assert.equal(route.isOidcPath('/nope'), false);
      assert.deepEqual(OIDC_PATHS, ['/auth/oidc/login', '/auth/oidc/callback', '/auth/session', '/auth/logout']);
    } finally {
      sessionStore.close();
    }
  });
});

test('#4267: the route surfaces the client classification without leaking the provider body', async (t) => {
  const idp = await startMockIdp({
    claimsFor: (entry) => ({ nonce: entry.nonce, sub: 'user-1', groups: ['huqan-approvers'] }),
  });
  const dir = tmpDir('huqan-oidc-sig-');
  const restore = setEnv(baseEnv(idp, dir));
  t.after(async () => { restore(); await idp.close(); });

  const config = loadOidcConfig();
  const sessionStore = createOidcSessionStore();
  t.after(() => sessionStore.close());
  // A stub client lets the test drive each library-level refusal (signature,
  // issuer, audience, expiry) through the real route, which must answer with the
  // classified code and never the provider's message.
  const failures = [
    [OIDC_FAILURE_CODES.ISSUER_MISMATCH, 'unexpected "iss" claim value'],
    [OIDC_FAILURE_CODES.AUDIENCE_MISMATCH, 'unexpected "aud" claim value'],
    [OIDC_FAILURE_CODES.TOKEN_INVALID, 'invalid signature'],
  ];
  for (const [code, message] of failures) {
    const route = createOidcRoute({
      config,
      client: {
        buildAuthorizationUrl: async () => new URL(`${idp.issuer}/authorize`),
        calculatePkceChallenge: async () => 'challenge',
        exchange: async () => {
          const error = new Error('token exchange failed');
          error.cause = new Error(message);
          error.code = code;
          throw error;
        },
      },
      sessionStore,
      rbacPolicy: { configured: false, ok: true },
      secureCookie: false,
    });
    const url = new URL('http://127.0.0.1:3000/auth/oidc/callback');
    const tx = route._transactions.begin();
    url.searchParams.set('code', 'c');
    url.searchParams.set('state', tx.state);
    const res = makeRes();
    await route.handle({ method: 'GET', headers: {} }, res, url);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, code);
    assert.ok(!res.body.includes(message), 'the provider body is not echoed');
  }
});

test('#4267: mount is disabled until advertised', async (t) => {
  await t.test('unconfigured mount is a no-op that never throws', () => {
    const mount = createOidcMount({ configResult: { configured: false, ok: true } });
    assert.equal(mount.enabled, false);
    assert.equal(mount.configured, false);
    // It claims none of its paths, so an OIDC-shaped request stays the unknown
    // route it was before this slice rather than being captured by a router
    // that cannot answer it. lib/saml/sp-route.js returns the same no-op.
    assert.equal(mount.isOidcPath('/auth/oidc/login'), false);
    assert.equal(mount.handle, undefined);
  });

  await t.test('an invalid config is reported, not thrown', () => {
    const mount = createOidcMount({ configResult: { configured: true, ok: false, reason: 'bad' } });
    assert.equal(mount.enabled, false);
    assert.equal(mount.ok, false);
    assert.equal(mount.reason, 'bad');
    assert.equal(mount.isOidcPath('/auth/oidc/login'), false);
  });

  await t.test('a configured mount stays unadvertised by default', async () => {
    const idp = await startMockIdp({ claimsFor: (e) => ({ nonce: e.nonce, sub: 'u', groups: ['huqan-approvers'] }) });
    const dir = tmpDir('huqan-oidc-mount-');
    const restore = setEnv(baseEnv(idp, dir));
    try {
      const mount = createOidcMount({ rbacPolicy: { configured: false, ok: true } });
      assert.equal(mount.configured, true);
      assert.equal(mount.ok, true);
      assert.equal(mount.enabled, false, 'SSO is not advertised until a smoke test passes');
      assert.equal(typeof mount.handle, 'function');
      assert.equal(typeof mount.authorize, 'function');
      assert.equal(mount.apiKeyFallback, false);
      mount.sessionStore.close();
    } finally {
      restore();
      await idp.close();
    }
  });
});

test('#4267: origin check is exact', () => {
  assert.equal(isAllowedOrigin({ headers: { origin: 'http://app.test' } }, 'http://app.test'), true);
  assert.equal(isAllowedOrigin({ headers: { origin: 'http://app.test.evil' } }, 'http://app.test'), false);
  assert.equal(isAllowedOrigin({ headers: {} }, 'http://app.test'), false);
});

test('#4267: server wires the OIDC mount through the viewer mount and the auth gate', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /viewerMount\.oidcMount/);
  assert.match(server, /oidcMount\.authorize\(req\)/);
  assert.match(server, /apiKeyFallback/);
  const mount = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http', 'viewer-mount.js'), 'utf8');
  assert.match(mount, /require\('\.\.\/oidc\/mount'\)/);
  assert.match(mount, /oidcMount\.isOidcPath/);
});
