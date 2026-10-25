'use strict';

// #4267 acceptance: a real login through the controlled mock IdP produces a
// session that authorizes a protected REST route through the shared
// `denyIfUnauthorized` gate, and logout revokes it so the route refuses again.
// No second authorization system: the same gate that accepts the API key
// accepts the OIDC session, and with OIDC configured the API key is refused
// unless the fallback switch is on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const API_KEY = 'oidc-runtime-test-key';
process.env.HUQAN_API_KEY = API_KEY;
process.env.AXIOM_API_KEY = API_KEY;

const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-4267-runtime-'));
process.env.HUQAN_MEMORY_PATH = path.join(tmpDir, 'memory.json');
process.env.HUQAN_DB_PATH = path.join(tmpDir, 'memory.db');
process.env.HUQAN_RECEIPT_COLLECTOR_ROOT = path.join(tmpDir, 'receipt-collector');

const { startMockIdp } = require('./helpers/oidc-mock-idp');

function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('#4267 runtime: OIDC session authorizes a protected REST route; logout revokes it', async (t) => {
  const idp = await startMockIdp({
    claimsFor: (entry) => ({ nonce: entry.nonce, sub: 'operator-1', groups: entry.groups }),
  });
  const issuer = `${idp.issuer}/`;
  const mappingFile = path.join(tmpDir, 'identity-mapping.json');
  fs.writeFileSync(mappingFile, JSON.stringify({
    version: 1,
    issuer,
    groupsClaim: 'groups',
    operatorIdStrategy: 'issuer-sub-sha256',
    groupRoles: { 'huqan-approvers': 'approver', 'huqan-admins': 'admin' },
    unmappedGroupPolicy: 'deny',
    roleConflictPolicy: 'deny',
  }));

  // The mount reads the environment once, when server.js is required, so the
  // redirect URI and origin must be known before that. Reserve a port first.
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: reserved } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(reserved)));
    });
    probe.once('error', reject);
  });
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    HUQAN_OIDC_ISSUER: issuer,
    HUQAN_OIDC_CLIENT_ID: 'huqan-rp',
    HUQAN_OIDC_CLIENT_SECRET: 'shhh',
    HUQAN_OIDC_REDIRECT_URI: `${origin}/auth/oidc/callback`,
    HUQAN_OIDC_ALLOWED_ORIGIN: origin,
    HUQAN_OIDC_IDENTITY_MAPPING_PATH: mappingFile,
    HUQAN_OIDC_SESSION_DB_PATH: path.join(tmpDir, 'sessions.db'),
    HUQAN_OIDC_INSECURE_LOOPBACK: '1',
  };
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    if (Object.hasOwn(process.env, k)) prev[k] = process.env[k];
    process.env[k] = v;
  }

  const server = require('../server');
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    server.closeHuqan();
    for (const k of Object.keys(env)) {
      if (Object.hasOwn(prev, k)) process.env[k] = prev[k];
      else delete process.env[k];
    }
    await idp.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const protectedRoute = '/api/audit';

  // With OIDC configured and the fallback off, the API key is not a credential.
  const apiKeyRefused = await request(port, protectedRoute, { headers: { Authorization: `Bearer ${API_KEY}` } });
  assert.equal(apiKeyRefused.status, 401, 'the API key is refused while OIDC mode is on and fallback is off');

  // No credential at all is still refused.
  const anonymous = await request(port, protectedRoute);
  assert.equal(anonymous.status, 401);

  // Start the login: the RP redirects to the discovered authorization endpoint.
  const login = await request(port, '/auth/oidc/login');
  assert.equal(login.status, 302);
  const authorization = new URL(login.headers.location);
  assert.equal(authorization.origin, idp.issuer);

  // The provider would authenticate the operator; the mock mints the code that
  // the token endpoint will accept for the nonce the RP bound.
  const code = idp.issueCode({
    clientId: 'huqan-rp',
    nonce: authorization.searchParams.get('nonce'),
    sub: 'operator-1',
    groups: ['huqan-approvers'],
  });
  const callbackPath = `/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(authorization.searchParams.get('state'))}`;
  const callback = await request(port, callbackPath);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, '/viewer');
  const setCookie = callback.headers['set-cookie'][0];
  const cookie = setCookie.split(';')[0];

  // The session endpoint reports the mapped identity and a CSRF token.
  const session = await request(port, '/auth/session', { headers: { cookie } });
  assert.equal(session.status, 200);
  const identity = JSON.parse(session.body);
  assert.match(identity.operatorId, /^oidc:[A-Za-z0-9_-]{43}$/);
  assert.equal(identity.role, 'approver');
  assert.ok(identity.csrfToken);

  // The session authorizes the protected REST route through the same gate.
  const authorized = await request(port, protectedRoute, { headers: { cookie } });
  assert.notEqual(authorized.status, 401, 'a valid OIDC session authorizes a protected REST route');

  // A state-changing cookie-authenticated request needs the CSRF token.
  const csrfMissing = await request(port, '/auth/logout', { method: 'POST', headers: { cookie, origin } });
  assert.equal(csrfMissing.status, 403);
  const foreignOrigin = await request(port, '/auth/logout', {
    method: 'POST',
    headers: { cookie, origin: 'http://evil.test', 'x-huqan-csrf': identity.csrfToken },
  });
  assert.equal(foreignOrigin.status, 403);

  // Logout revokes the session, and the protected route refuses afterwards.
  const logout = await request(port, '/auth/logout', {
    method: 'POST',
    headers: { cookie, origin, 'x-huqan-csrf': identity.csrfToken },
  });
  assert.equal(logout.status, 204);
  const afterLogout = await request(port, protectedRoute, { headers: { cookie } });
  assert.equal(afterLogout.status, 401, 'a revoked session no longer authorizes the route');
});
