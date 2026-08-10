'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createSessionStore } = require('../lib/viewer/session-store');
const { createViewerGateway } = require('../lib/viewer/viewer-gateway');

const API_KEY = 'viewer-test-operator-key';
const ORIGIN = 'http://127.0.0.1:3000';
const HOST = '127.0.0.1:3000';

function request({ method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = path;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  req.socket = { localAddress: '127.0.0.1' };
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    },
    end(chunk = '') {
      this.body += chunk ? String(chunk) : '';
    },
  };
}

function cookiePair(setCookie) {
  return String(setCookie).split(';', 1)[0];
}

function makeGateway(options = {}) {
  const store = options.store || createSessionStore(options.storeOptions);
  const receipt = Object.freeze({ receiptId: 'receipt-1', verdict: 'ALLOW', reason: 'verified' });
  const reads = [];
  const gateway = createViewerGateway({
    sessionStore: store,
    configuredKey: () => options.apiKey === undefined ? API_KEY : options.apiKey,
    allowInsecureLoopback: () => options.insecureLoopback !== false,
    readReceipt: options.readReceipt || ((receiptId, filters) => {
      reads.push({ receiptId, filters });
      if (receiptId !== receipt.receiptId || (filters.workspaceId && filters.workspaceId !== 'default')) {
        return { ok: false, status: 'not_found', error: { message: 'receipt not found' } };
      }
      return { ok: true, receipt };
    }),
  });
  return { gateway, store, receipt, reads };
}

async function invoke(gateway, options) {
  const req = request(options);
  const res = response();
  const url = new URL(options.path || '/', `http://${req.headers.host || HOST}`);
  await gateway.handle(req, res, url);
  return res;
}

async function login(gateway, overrides = {}) {
  return invoke(gateway, {
    method: 'POST',
    path: '/viewer/session',
    headers: {
      host: HOST,
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(overrides.headers || {}),
    },
    body: overrides.body === undefined ? JSON.stringify({ apiKey: API_KEY }) : overrides.body,
  });
}

test('V4-UI-0B viewer session gateway', async (t) => {
  await t.test('creates an opaque loopback session with bounded cookie attributes', async () => {
    const { gateway, store } = makeGateway();
    const res = await login(gateway);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['set-cookie'], /^axiom_viewer_session=[A-Za-z0-9_-]{43};/);
    assert.match(res.headers['set-cookie'], /Path=\/viewer; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    assert.equal(res.headers['set-cookie'].includes('Secure'), false);
    assert.equal(store.size(), 1);
    assert.deepEqual(JSON.parse(res.body).ok, true);
  });

  await t.test('defaults to a Secure cookie and requires HTTPS same-origin login', async () => {
    const { gateway } = makeGateway({ insecureLoopback: false });
    const rejected = await login(gateway);
    assert.equal(rejected.statusCode, 403);
    const accepted = await login(gateway, { headers: { origin: 'https://127.0.0.1:3000' } });
    assert.equal(accepted.statusCode, 200);
    assert.match(accepted.headers['set-cookie'], /^__Secure-axiom_viewer_session=/);
    assert.match(accepted.headers['set-cookie'], /; Secure;/);
  });

  await t.test('rejects missing, invalid, and cross-origin credentials without state change', async () => {
    const { gateway, store } = makeGateway();
    const wrong = await login(gateway, { body: JSON.stringify({ apiKey: 'wrong' }) });
    const missing = await login(gateway, { body: '{}' });
    const crossOrigin = await login(gateway, { headers: { origin: 'https://evil.test' } });
    const noOrigin = await login(gateway, { headers: { origin: undefined } });
    assert.deepEqual([wrong.statusCode, missing.statusCode, crossOrigin.statusCode, noOrigin.statusCode], [401, 401, 403, 403]);
    assert.equal(store.size(), 0);
    for (const res of [wrong, missing, crossOrigin, noOrigin]) assert.equal(res.headers['set-cookie'], undefined);
  });

  await t.test('rejects unsupported, malformed, and oversized login bodies', async () => {
    const { gateway, store } = makeGateway();
    const unsupported = await invoke(gateway, {
      method: 'POST', path: '/viewer/session', headers: { host: HOST, origin: ORIGIN, 'content-type': 'text/plain' }, body: '{}',
    });
    const malformed = await login(gateway, { body: '{' });
    const oversized = await login(gateway, { body: JSON.stringify({ apiKey: 'x'.repeat(1100) }) });
    assert.deepEqual([unsupported.statusCode, malformed.statusCode, oversized.statusCode], [415, 400, 413]);
    assert.equal(store.size(), 0);
  });

  await t.test('requires a valid session and preserves the canonical receipt payload', async () => {
    const { gateway, receipt, reads } = makeGateway();
    const unauthenticated = await invoke(gateway, { path: '/viewer/api/trust-receipt/receipt-1', headers: { host: HOST } });
    assert.equal(unauthenticated.statusCode, 401);
    assert.match(unauthenticated.headers['set-cookie'], /Max-Age=0/);

    const session = await login(gateway);
    const authenticated = await invoke(gateway, {
      path: '/viewer/api/trust-receipt/receipt-1?workspaceId=default',
      headers: { host: HOST, cookie: cookiePair(session.headers['set-cookie']) },
    });
    assert.equal(authenticated.statusCode, 200);
    assert.deepEqual(JSON.parse(authenticated.body), { ok: true, receipt });
    assert.deepEqual(reads, [{ receiptId: 'receipt-1', filters: { workspaceId: 'default' } }]);
  });

  await t.test('binds the session to the workspace declared at login and blocks cross-workspace reads (#404)', async () => {
    const { gateway, reads } = makeGateway();
    const session = await login(gateway, { body: JSON.stringify({ apiKey: API_KEY, workspaceId: 'workspace-a' }) });
    assert.equal(JSON.parse(session.body).workspaceId, 'workspace-a');
    const headers = { host: HOST, cookie: cookiePair(session.headers['set-cookie']) };

    // A ?workspaceId= that matches the session's own workspace is fine.
    const sameWorkspace = await invoke(gateway, {
      path: '/viewer/api/trust-receipt/receipt-1?workspaceId=workspace-a', headers,
    });
    assert.equal(sameWorkspace.statusCode, 404); // fixture receipt only exists in 'default'
    assert.deepEqual(reads[0], { receiptId: 'receipt-1', filters: { workspaceId: 'workspace-a' } });

    // A ?workspaceId= naming a *different* workspace than the session's own
    // must be rejected before the receipt source is ever queried -- this is
    // the cross-workspace IDOR the session binding closes.
    const crossWorkspace = await invoke(gateway, {
      path: '/viewer/api/trust-receipt/receipt-1?workspaceId=workspace-b', headers,
    });
    assert.equal(crossWorkspace.statusCode, 403);
    assert.deepEqual(JSON.parse(crossWorkspace.body), {
      ok: false,
      error: { code: 'cross_workspace', message: 'workspaceId does not match the authenticated session' },
    });
    assert.equal(reads.length, 1); // no second read call for the rejected cross-workspace attempt

    // Omitting ?workspaceId= entirely falls back to the session's own
    // workspace rather than an unscoped/default read.
    const omitted = await invoke(gateway, { path: '/viewer/api/trust-receipt/receipt-1', headers });
    assert.equal(omitted.statusCode, 404);
    assert.deepEqual(reads[1], { receiptId: 'receipt-1', filters: { workspaceId: 'workspace-a' } });
  });

  await t.test('maps malformed and unknown receipt identifiers fail-closed', async () => {
    const { gateway } = makeGateway();
    const session = await login(gateway);
    const headers = { host: HOST, cookie: cookiePair(session.headers['set-cookie']) };
    const malformed = await invoke(gateway, { path: '/viewer/api/trust-receipt/%00', headers });
    const missing = await invoke(gateway, { path: '/viewer/api/trust-receipt/', headers });
    const unknown = await invoke(gateway, { path: '/viewer/api/trust-receipt/unknown', headers });
    assert.deepEqual([malformed.statusCode, missing.statusCode, unknown.statusCode], [400, 400, 404]);
  });

  await t.test('contains receipt-source errors in the viewer envelope', async () => {
    const { gateway } = makeGateway({ readReceipt: () => { throw new Error('sentinel internal error'); } });
    const session = await login(gateway);
    const res = await invoke(gateway, {
      path: '/viewer/api/trust-receipt/receipt-1', headers: { host: HOST, cookie: cookiePair(session.headers['set-cookie']) },
    });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), {
      ok: false,
      error: { code: 'receipt_read_failed', message: 'receipt could not be read' },
    });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  await t.test('rotates on login and logout invalidates the session idempotently', async () => {
    const { gateway, store } = makeGateway();
    const first = await login(gateway);
    const firstCookie = cookiePair(first.headers['set-cookie']);
    const second = await login(gateway, { headers: { cookie: firstCookie } });
    assert.equal(store.size(), 1);
    assert.notEqual(cookiePair(second.headers['set-cookie']), firstCookie);

    const logout = await invoke(gateway, {
      method: 'DELETE', path: '/viewer/session', headers: { host: HOST, origin: ORIGIN, cookie: cookiePair(second.headers['set-cookie']) },
    });
    assert.equal(logout.statusCode, 204);
    assert.match(logout.headers['set-cookie'], /Max-Age=0/);
    assert.equal(store.size(), 0);
  });

  await t.test('expires sessions and never calls the receipt source after expiry', async () => {
    let now = 0;
    let calls = 0;
    const store = createSessionStore({ idleTtlMs: 10, absoluteTtlMs: 100, now: () => now });
    const { gateway } = makeGateway({ store, readReceipt: () => { calls += 1; return { ok: true, receipt: {} }; } });
    const session = await login(gateway);
    now = 10;
    const expired = await invoke(gateway, {
      path: '/viewer/api/trust-receipt/receipt-1', headers: { host: HOST, cookie: cookiePair(session.headers['set-cookie']) },
    });
    assert.equal(expired.statusCode, 401);
    assert.equal(calls, 0);
  });

  await t.test('does not downgrade cookies unless flag, socket, and Host are loopback', async () => {
    const { gateway } = makeGateway();
    const res = await login(gateway, { headers: { host: 'example.test', origin: 'https://example.test' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['set-cookie'], /^__Secure-axiom_viewer_session=/);
    assert.match(res.headers['set-cookie'], /; Secure;/);
  });

  await t.test('does not emit CORS headers and never forwards unknown viewer routes', async () => {
    const { gateway, reads } = makeGateway();
    const responses = [
      await login(gateway),
      await invoke(gateway, { method: 'OPTIONS', path: '/viewer/session', headers: { host: HOST, origin: ORIGIN } }),
      await invoke(gateway, { path: '/viewer/unknown', headers: { host: HOST } }),
    ];
    assert.deepEqual(responses.map((item) => item.statusCode), [200, 405, 404]);
    for (const res of responses) {
      assert.equal(Object.keys(res.headers).some((name) => name.startsWith('access-control-')), false);
    }
    assert.equal(reads.length, 0);
  });

  await t.test('allows only the bounded route methods', async () => {
    const { gateway } = makeGateway();
    const session = await login(gateway);
    const receipt = await invoke(gateway, {
      method: 'POST', path: '/viewer/api/trust-receipt/receipt-1', headers: { host: HOST, cookie: cookiePair(session.headers['set-cookie']) },
    });
    const sessionGet = await invoke(gateway, { path: '/viewer/session', headers: { host: HOST } });
    assert.deepEqual([receipt.statusCode, receipt.headers.allow, sessionGet.statusCode, sessionGet.headers.allow], [405, 'GET', 405, 'POST, DELETE']);
  });
});

function serverRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? '' : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: responseBody ? JSON.parse(responseBody) : null,
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('V4-UI-0B server wiring keeps viewer auth isolated from the canonical API', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-ui-0b-'));
  const previous = Object.fromEntries([
    'AXIOM_DISABLE_AUTO_LISTEN',
    'AXIOM_API_KEY',
    'AXIOM_MEMORY_PATH',
    'AXIOM_USE_SQLITE',
    'AXIOM_VIEWER_INSECURE_LOOPBACK',
  ].map((name) => [name, { present: Object.hasOwn(process.env, name), value: process.env[name] }]));
  let server;
  try {
    process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
    process.env.AXIOM_API_KEY = API_KEY;
    process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
    process.env.AXIOM_USE_SQLITE = 'false';
    process.env.AXIOM_VIEWER_INSECURE_LOOPBACK = '1';
    server = require('../server');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;

    const loginResponse = await serverRequest(port, '/viewer/session', {
      method: 'POST', headers: { Origin: origin }, body: { apiKey: API_KEY },
    });
    assert.equal(loginResponse.statusCode, 200);
    const sessionCookie = loginResponse.headers['set-cookie'][0].split(';', 1)[0];

    const viewerRead = await serverRequest(port, '/viewer/api/trust-receipt/unknown', {
      headers: { Cookie: sessionCookie, Origin: origin },
    });
    assert.equal(viewerRead.statusCode, 404);
    assert.equal(viewerRead.body.error.code, 'receipt_not_found');
    assert.equal(Object.keys(viewerRead.headers).some((name) => name.startsWith('access-control-')), false);

    const viewerOptions = await serverRequest(port, '/viewer/session', {
      method: 'OPTIONS', headers: { Origin: origin },
    });
    assert.equal(viewerOptions.statusCode, 405);
    assert.equal(Object.keys(viewerOptions.headers).some((name) => name.startsWith('access-control-')), false);

    const canonicalRead = await serverRequest(port, '/api/trust-receipt/unknown', {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(canonicalRead.statusCode, 401);

    let rateLimited = false;
    for (let index = 0; index < 130 && !rateLimited; index += 1) {
      const attempt = await serverRequest(port, '/viewer/session', {
        method: 'POST',
        headers: { Origin: origin, 'X-API-Key': `attacker-bucket-${index}` },
        body: { apiKey: 'wrong' },
      });
      rateLimited = attempt.statusCode === 429;
    }
    assert.equal(rateLimited, true, 'rotating X-API-Key headers must not bypass the viewer IP bucket');

    for (let index = 0; index < 10; index += 1) {
      const filler = await serverRequest(port, '/api/trust-receipt/unknown', {
        headers: { 'X-API-Key': `canonical-filler-${index}` },
      });
      assert.ok(
        filler.statusCode === 401 || filler.statusCode === 429,
        'unauthenticated canonical traffic must be rejected or fail closed under rate limiting',
      );
    }
    const stillLimited = await serverRequest(port, '/viewer/session', {
      method: 'POST', headers: { Origin: origin }, body: { apiKey: 'wrong' },
    });
    assert.equal(stillLimited.statusCode, 429, 'canonical API buckets must not evict the viewer bucket');
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    server?.closeAxiom?.();
    delete require.cache[require.resolve('../server')];
    for (const [name, snapshot] of Object.entries(previous)) {
      if (snapshot.present) process.env[name] = snapshot.value;
      else delete process.env[name];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
