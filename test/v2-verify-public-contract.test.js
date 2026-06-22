'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_API_KEY = 'test-verify-surface-key';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { Connection: 'close', ...(options.headers || {}) };
    if (!options.skipAuth) headers['X-API-Key'] = TEST_API_KEY;
    const req = http.request({
      method: options.method || 'GET',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          json: () => { try { return JSON.parse(body || '{}'); } catch { return null; } },
          text: () => body,
        });
        res.destroy();
        req.destroy();
      });
    });
    req.on('error', reject);
    req.on('socket', (s) => s.unref?.());
    if (options.body !== undefined && options.body !== null) req.write(options.body);
    req.end();
  });
}

function startServer(envOverrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-verify-public-'));
  process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
  process.env.AXIOM_BACKUP_DIR = path.join(tempDir, 'backups');
  process.env.AXIOM_KERNEL_VERSION = 'v2';
  process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
  process.env.AXIOM_API_KEY = TEST_API_KEY;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }

  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  server.keepAliveTimeout = 1;
  server.headersTimeout = 2000;
  server.requestTimeout = 2000;
  server.maxRequestsPerSocket = 1;
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      const PORT = server.address().port;
      resolve({ server, base: `http://127.0.0.1:${PORT}`, tempDir });
    });
    server.once('error', reject);
    server.startServer(0);
  });
}

async function stopServer(ctx) {
  if (!ctx) return;
  ctx.server.closeAllConnections?.();
  ctx.server.closeIdleConnections?.();
  ctx.server.closeAxiom?.();
  await new Promise((resolve) => ctx.server.close(() => resolve()));
  ctx.server.closeAllConnections?.();
  ctx.server.closeIdleConnections?.();
  if (ctx.tempDir) fs.rmSync(ctx.tempDir, { recursive: true, force: true });
}

describe('POST /v2/verify default-protected contract', () => {
  let ctx;
  before(async () => { ctx = await startServer({ HUQAN_PUBLIC_VERIFY: null }); });
  after(async () => { await stopServer(ctx); });

  it('rejects unauthenticated POST when public flag is not set', async () => {
    const res = await request(`${ctx.base}/v2/verify`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('accepts authenticated POST and returns full envelope', async () => {
    const res = await request(`${ctx.base}/v2/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.strictEqual(res.status, 200);
    const body = res.json();
    assert.ok(body.ok === true || body.type === 'verify' || body.data);
    assert.ok(!('public' in body), 'authenticated response must not carry public flag');
  });

  it('GET /v2/verify still returns 405', async () => {
    const res = await request(`${ctx.base}/v2/verify?statement=test`, { skipAuth: true });
    assert.strictEqual(res.status, 405);
  });
});

describe('POST /v2/verify public/demo contract (HUQAN_PUBLIC_VERIFY=1)', () => {
  let ctx;
  before(async () => { ctx = await startServer({ HUQAN_PUBLIC_VERIFY: '1' }); });
  after(async () => {
    await stopServer(ctx);
    delete process.env.HUQAN_PUBLIC_VERIFY;
  });

  it('accepts unauthenticated POST and returns sanitized envelope', async () => {
    const res = await request(`${ctx.base}/v2/verify`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.strictEqual(res.status, 200);
    const body = res.json();
    assert.strictEqual(body.public, true, 'public flag must be set on public response');
    assert.strictEqual(body.type, 'verify');
    assert.ok(body.data, 'data envelope must exist');
  });

  it('public response must not contain evidence, reasoningTrace, trustReceiptPreview, or entityResolution', async () => {
    const res = await request(`${ctx.base}/v2/verify`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    const raw = res.text();
    for (const forbidden of ['evidence', 'reasoningTrace', 'trustReceiptPreview', 'entityResolution', 'provenance', 'workspaceId']) {
      assert.ok(!raw.includes(forbidden), `public response must not contain "${forbidden}". raw=${raw.slice(0, 400)}`);
    }
    const body = res.json();
    const allowedDataKeys = new Set(['status', 'confidence', 'classification', 'risk']);
    for (const key of Object.keys(body.data || {})) {
      assert.ok(allowedDataKeys.has(key), `public data must not expose "${key}"`);
    }
  });

  it('public mode ignores arbitrary workspaceId from request body', async () => {
    const res = await request(`${ctx.base}/v2/verify`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer', workspaceId: 'attacker-probe-workspace' }),
    });
    assert.strictEqual(res.status, 200);
    const raw = res.text();
    assert.ok(!raw.includes('attacker-probe-workspace'), 'public response must not leak supplied workspaceId');
  });

  it('authenticated request in public mode still returns full envelope', async () => {
    const res = await request(`${ctx.base}/v2/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.strictEqual(res.status, 200);
    const body = res.json();
    assert.ok(!('public' in body), 'authenticated response must not carry public flag even when HUQAN_PUBLIC_VERIFY=1');
  });

  it('mutation endpoint /yukle remains protected under public verify flag', async () => {
    const res = await request(`${ctx.base}/yukle`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'kedi memeli' }),
    });
    assert.strictEqual(res.status, 401, 'mutation endpoint must still require api key');
  });
});
