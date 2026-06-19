const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');

let PORT;
let BASE;
const TEST_API_KEY = 'test-server-secret';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let socket = null;
    const defaultHeaders = options.skipAuth ? {} : { 'X-API-Key': TEST_API_KEY };
    const req = http.request({
      method: options.method || 'GET',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { Connection: 'close', ...defaultHeaders, ...(options.headers || {}) },
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const payload = {
          status: res.statusCode,
          headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
          json: async () => JSON.parse(body.toString('utf8') || '{}'),
          text: async () => body.toString('utf8'),
        };
        socket?.destroy();
        res.destroy();
        req.destroy();
        resolve(payload);
      });
    });
    req.on('error', reject);
    req.on('socket', (s) => {
      socket = s;
      s.unref?.();
    });
    if (options.body !== undefined && options.body !== null) {
      req.write(options.body);
    }
    req.end();
  });
}

let server;
let tempDir;
before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-security-'));
  process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
  process.env.AXIOM_BACKUP_DIR = path.join(tempDir, 'backups');
  process.env.AXIOM_KERNEL_VERSION = 'v2';
  process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
  process.env.AXIOM_TEST_STATUS = 'static-test-status';
  process.env.AXIOM_API_KEY = TEST_API_KEY;
  server = require('./server');
  server.keepAliveTimeout = 1;
  server.headersTimeout = 2_000;
  server.requestTimeout = 2_000;
  server.maxRequestsPerSocket = 1;
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.startServer(0);
  });
  PORT = server.address().port;
  BASE = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  server.closeAxiom?.();
  await new Promise((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  delete process.env.AXIOM_MEMORY_PATH;
  delete process.env.AXIOM_DB_PATH;
  delete process.env.AXIOM_BACKUP_DIR;
  delete process.env.AXIOM_KERNEL_VERSION;
  delete process.env.AXIOM_DISABLE_AUTO_LISTEN;
  delete process.env.AXIOM_TEST_STATUS;
  delete process.env.AXIOM_API_KEY;
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Security baseline hardening', () => {
  it('GET verify routes are blocked', async () => {
    for (const pathName of ['/v2/verify?statement=test', '/dogrula?statement=test', '/verify?statement=test']) {
      const res = await request(`${BASE}${pathName}`, { skipAuth: true });
      assert.strictEqual(res.status, 405);
      const body = await res.json();
      assert.strictEqual(body.error, 'Method not allowed');
      assert.strictEqual(body.message, 'Use POST /v2/verify');
    }
  });

  it('POST /v2/verify works for local demo without an API key', async () => {
    const res = await request(`${BASE}/v2/verify`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.type, 'verify');
    assert.ok(body.data);
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(body.data.status));
  });

  it('GET /health is reduced to minimal safe metadata', async () => {
    const res = await request(`${BASE}/health`, { skipAuth: true });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, { ok: true });
  });

  it('GET /v2-status is reduced to minimal safe metadata', async () => {
    const res = await request(`${BASE}/v2-status`, { skipAuth: true });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.service, 'axiom');
    assert.strictEqual(body.status, 'running');
    assert.strictEqual(body.version, require('./package.json').version);
    assert.deepStrictEqual(Object.keys(body).sort(), ['ok', 'service', 'status', 'version']);
    for (const key of ['phases', 'counts', 'progressPercent', 'remainingPhases', 'currentFocus', 'agentRuntime', 'agentCheckpointPath', 'persistencePaths']) {
      assert.ok(!(key in body), `${key} should not be exposed`);
    }
  });

  it('public index uses POST /v2/verify', async () => {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    assert.ok(html.includes("fetch('/v2/verify', {"));
    assert.ok(html.includes("method: 'POST'"));
    assert.ok(!html.includes('/v2/verify?statement='));
  });
});
