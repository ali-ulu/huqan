'use strict';

/**
 * P1-4 Tool Call Bypass Regression
 *
 * Proves that the gate surfaces enforced by PRs #115-#118 cannot be bypassed.
 * Covers four bypass vectors:
 *   1. MCP gate — case/whitespace/type variants of gated tool names
 *   2. MCP gate — null/invalid params are fail-closed (no throw)
 *   3. MCP gate — proto-pollution and injection names are blocked
 *   4. MCP gate — axiom.learn is gated regardless of argument shape
 *   5. MCP gate — gated envelope contract is structurally consistent
 *   6. HTTP — mutation and legacy endpoints remain protected
 *   7. Static demo — no bypass patterns in public/index.html
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { callTool } = require('../mcpServer');

// ── Spy kernel ───────────────────────────────────────────────────────────────

function makeSpyKernel() {
  const calls = { learn: 0, ask: 0, verify: 0, reason: 0, compare: 0, dream: 0 };
  return {
    _calls: calls,
    learn(text)    { calls.learn++;   return { ok: true }; },
    ask(q)         { calls.ask++;     return { ok: true, type: 'ask',    data: { answer: String(q || '') }, evidence: [], error: null, meta: {} }; },
    verify(s)      { calls.verify++;  return { ok: true, type: 'verify', data: { status: 'bilinmiyor', confidence: 0 }, evidence: [], error: null, meta: {} }; },
    reason(s)      { calls.reason++;  return { ok: true, type: 'reason', data: {}, evidence: [], error: null, meta: {} }; },
    compare(l, r)  { calls.compare++; return { ok: true, type: 'compare', data: {}, evidence: [], error: null, meta: {} }; },
    dream(opts)    { calls.dream++;   return { ok: true, type: 'dream',  data: {}, evidence: [], error: null, meta: {} }; },
    graph: { getStats: () => ({ backend: 'memory', nodes: 0, edges: 0 }) },
  };
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-server-secret';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const defaultHeaders = options.skipAuth ? {} : { 'X-API-Key': TEST_API_KEY };
    const req = http.request({
      method: options.method || 'GET',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { Connection: 'close', ...defaultHeaders, ...(options.headers || {}) },
      agent: false,
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          json: async () => JSON.parse(body.toString('utf8') || '{}'),
          text: async () => body.toString('utf8'),
        });
        res.destroy();
        req.destroy();
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

// ── Server setup ─────────────────────────────────────────────────────────────

let server, BASE, tempDir;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-bypass-reg-'));
  process.env.AXIOM_MEMORY_PATH    = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH        = path.join(tempDir, 'memory.db');
  process.env.AXIOM_BACKUP_DIR     = path.join(tempDir, 'backups');
  process.env.AXIOM_KERNEL_VERSION = 'v2';
  process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
  process.env.AXIOM_TEST_STATUS    = 'bypass-regression';
  process.env.AXIOM_API_KEY        = TEST_API_KEY;
  server = require('../server');
  server.keepAliveTimeout   = 1;
  server.headersTimeout     = 2_000;
  server.requestTimeout     = 2_000;
  server.maxRequestsPerSocket = 1;
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.startServer(0);
  });
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  server.closeAxiom?.();
  await new Promise((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
  for (const k of [
    'AXIOM_MEMORY_PATH', 'AXIOM_DB_PATH', 'AXIOM_BACKUP_DIR',
    'AXIOM_KERNEL_VERSION', 'AXIOM_DISABLE_AUTO_LISTEN', 'AXIOM_TEST_STATUS', 'AXIOM_API_KEY',
  ]) delete process.env[k];
  await new Promise((r) => setTimeout(r, 25));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── Suite 1: Case and whitespace bypass attempts ──────────────────────────

describe('P1-4 MCP gate — case and whitespace variants are blocked', () => {
  it('AXIOM.LEARN (uppercase) is blocked; kernel.learn never called', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'AXIOM.LEARN', arguments: { text: 'x' } });
    assert.equal(k._calls.learn, 0, 'kernel.learn must not be called');
    assert.equal(r.ok, false);
  });

  it('Axiom.learn (mixed case) is blocked; kernel.learn never called', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'Axiom.learn', arguments: { text: 'x' } });
    assert.equal(k._calls.learn, 0);
    assert.equal(r.ok, false);
  });

  it('"axiom.learn " (trailing space) is blocked; kernel.learn never called', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'axiom.learn ', arguments: { text: 'x' } });
    assert.equal(k._calls.learn, 0);
    assert.equal(r.ok, false);
  });

  it('"axiom.learn\\t" (tab suffix) is blocked; kernel.learn never called', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'axiom.learn\t' });
    assert.equal(k._calls.learn, 0);
    assert.equal(r.ok, false);
  });

  it('AXIOM.AGENT (uppercase) is blocked', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'AXIOM.AGENT', arguments: { goal: 'run everything' } });
    assert.equal(r.ok, false);
  });

  it('"axiom.agent " (trailing space) is blocked', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'axiom.agent ' });
    assert.equal(r.ok, false);
  });

  it('"axiom.ask " (trailing space on allowed tool) is blocked, kernel.ask never called', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'axiom.ask ', arguments: { question: 'nedir' } });
    assert.equal(k._calls.ask, 0, 'kernel.ask must not be called for spoofed name');
    assert.equal(r.ok, false);
  });
});

// ── Suite 2: Null/invalid params are fail-closed ─────────────────────────

describe('P1-4 MCP gate — null and invalid params do not throw', () => {
  it('callTool(kernel, null) does not throw; returns blocked envelope', () => {
    const k = makeSpyKernel();
    let r;
    assert.doesNotThrow(() => { r = callTool(k, null); });
    assert.equal(r.ok, false, 'null params must be fail-closed');
    assert.equal(k._calls.learn, 0);
  });

  it('callTool(kernel) with no second arg does not throw; returns blocked envelope', () => {
    const k = makeSpyKernel();
    let r;
    assert.doesNotThrow(() => { r = callTool(k); });
    assert.equal(r.ok, false);
  });

  it('callTool with { name: null } is blocked', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: null });
    assert.equal(r.ok, false);
    assert.equal(k._calls.learn, 0);
  });

  it('callTool with { name: 123 } (number) is blocked', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 123 });
    assert.equal(r.ok, false);
  });

  it('callTool with { name: [] } (array) is blocked', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: [] });
    assert.equal(r.ok, false);
  });

  it('callTool with { name: "" } (empty string) is blocked', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: '' });
    assert.equal(r.ok, false);
  });
});

// ── Suite 3: Proto-pollution and injection names ──────────────────────────

describe('P1-4 MCP gate — proto-pollution and injection names are blocked', () => {
  it('"__proto__" tool name is blocked, does not throw', () => {
    const k = makeSpyKernel();
    let r;
    assert.doesNotThrow(() => { r = callTool(k, { name: '__proto__' }); });
    assert.equal(r.ok, false);
  });

  it('"constructor" tool name is blocked, does not throw', () => {
    const k = makeSpyKernel();
    let r;
    assert.doesNotThrow(() => { r = callTool(k, { name: 'constructor' }); });
    assert.equal(r.ok, false);
  });

  it('"toString" tool name is blocked', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'toString' });
    assert.equal(r.ok, false);
  });

  it('"axiom.learn;kernel.learn()" injection suffix is blocked; kernel.learn never called', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'axiom.learn;kernel.learn()' });
    assert.equal(k._calls.learn, 0);
    assert.equal(r.ok, false);
  });

  it('"axiom.learn/../admin" path injection is blocked', () => {
    const k = makeSpyKernel();
    const r = callTool(k, { name: 'axiom.learn/../admin' });
    assert.equal(k._calls.learn, 0);
    assert.equal(r.ok, false);
  });
});

// ── Suite 4: axiom.learn gated regardless of argument shape ──────────────

describe('P1-4 MCP gate — axiom.learn is gated for all argument shapes', () => {
  const learnCases = [
    ['empty arguments object',     { name: 'axiom.learn', arguments: {} }],
    ['null arguments',             { name: 'axiom.learn', arguments: null }],
    ['no arguments key',           { name: 'axiom.learn' }],
    ['large text argument',        { name: 'axiom.learn', arguments: { text: 'x'.repeat(100_000) } }],
    ['extra bypass fields',        { name: 'axiom.learn', arguments: { text: 'x', bypass: true, admin: true, override: 1 } }],
  ];

  for (const [label, params] of learnCases) {
    it(`axiom.learn gated with ${label}`, () => {
      const k = makeSpyKernel();
      const r = callTool(k, params);
      assert.equal(k._calls.learn, 0,               'kernel.learn must NEVER be called');
      assert.equal(r.ok, false,                      'gate must be fail-closed');
      assert.equal(r.meta.gate, 'review',            'gate decision must be review');
      assert.equal(r.error.code, 'MUTATING_REQUIRES_REVIEW');
    });
  }
});

// ── Suite 5: Gated envelope contract is structurally consistent ──────────

describe('P1-4 MCP gate — gated envelope structure never leaks internals', () => {
  const cases = [
    ['axiom.learn',      { name: 'axiom.learn',             arguments: {} }, 'review',       'MUTATING_REQUIRES_REVIEW'],
    ['axiom.agent',      { name: 'axiom.agent',             arguments: {} }, 'dry_run_only', 'AGENT_LOOP_DRY_RUN_ONLY'],
    ['unknown tool',     { name: 'axiom.delete_everything', arguments: {} }, 'block',        'UNKNOWN_TOOL_BLOCKED'],
    ['uppercase variant',{ name: 'AXIOM.LEARN',             arguments: {} }, 'block',        'UNKNOWN_TOOL_BLOCKED'],
    ['null name',        { name: null },                                      'block',        'UNKNOWN_TOOL_BLOCKED'],
    ['null params',      null,                                                'block',        'UNKNOWN_TOOL_BLOCKED'],
  ];

  for (const [label, params, expectedGate, expectedCode] of cases) {
    it(`${label}: ok:false, correct gate, no internal kernel data exposed`, () => {
      const k = makeSpyKernel();
      const r = callTool(k, params);

      assert.equal(r.ok, false,                 'must be fail-closed');
      assert.equal(r.meta.gate, expectedGate,   `gate must be "${expectedGate}"`);
      assert.equal(r.error.code, expectedCode,  `code must be "${expectedCode}"`);
      assert.equal(typeof r.error.message, 'string', 'error.message must be a string');
      assert.ok(Array.isArray(r.evidence),      'evidence must always be an array');
      assert.ok(r.data !== null && typeof r.data === 'object', 'data must be an object');

      // Kernel internals must not leak out of gated responses.
      for (const field of ['nodes', 'edges', 'stats', 'kernel', 'graph', 'backend', 'uptimeSec']) {
        assert.ok(!(field in r), `internal field "${field}" must not appear in gated response`);
      }
    });
  }
});

// ── Suite 6: HTTP mutation and legacy endpoints remain protected ──────────

describe('P1-4 HTTP — mutation and legacy endpoints remain protected', () => {
  it('POST /dogrula without API key → 401 (legacy verify endpoint)', async () => {
    const res = await request(`${BASE}/dogrula`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /verify without API key → 401 (legacy verify alias)', async () => {
    const res = await request(`${BASE}/verify`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /yukle without API key → 401 (memory mutation endpoint)', async () => {
    const res = await request(`${BASE}/yukle`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'kedi hayvandir' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /upload without API key → 401 (mutation alias)', async () => {
    const res = await request(`${BASE}/upload`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'kedi hayvandir' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /llm-sor without API key → 401 (LLM ask endpoint)', async () => {
    const res = await request(`${BASE}/llm-sor`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'kedi nedir' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /v2/verify without API key and no HUQAN_PUBLIC_VERIFY flag → 401', async () => {
    const res = await request(`${BASE}/v2/verify`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /v2/verify with workspaceId in query string → 401 (workspace probing blocked by auth gate)', async () => {
    const res = await request(`${BASE}/v2/verify?workspaceId=secret-workspace`, {
      method: 'POST',
      skipAuth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'test' }),
    });
    // No HUQAN_PUBLIC_VERIFY → auth gate fires first; workspace never reached.
    assert.equal(res.status, 401);
  });

  it('POST /v2/verify with valid API key → 200 (authenticated path unaffected)', async () => {
    const res = await request(`${BASE}/v2/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi balik yer' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.type, 'verify');
  });
});

// ── Suite 7: Static demo bypass regression ────────────────────────────────

describe('P1-4 Static demo — public/index.html has no bypass patterns', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  it('demo uses POST /v2/verify (not GET query-string pattern)', () => {
    assert.ok(html.includes("fetch('/v2/verify', {"), 'must contain POST fetch call');
    assert.ok(html.includes("method: 'POST'"),         'must specify POST method');
    assert.ok(!html.includes('/v2/verify?statement='), 'must NOT use GET query-string pattern');
  });

  it('demo has no external CDN or provider script references', () => {
    for (const pattern of [
      'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net',
      'unpkg.com', 'cdnjs', 'd3.min.js', 'remixicon',
      'openai.com', 'anthropic.com', 'openrouter.ai',
    ]) {
      assert.ok(!html.includes(pattern), `must not reference external resource: ${pattern}`);
    }
  });

  it('demo has no browser secret-storage writes', () => {
    assert.ok(!html.includes('localStorage.setItem'),  'must not write to localStorage');
    assert.ok(!html.includes('sessionStorage.setItem'), 'must not write to sessionStorage');
  });

  it('demo has no embedded API key or credential patterns', () => {
    assert.ok(!html.includes('api_key'), 'must not embed api_key');
    assert.ok(!html.includes('apikey'),  'must not embed apikey');
    assert.ok(!html.includes('sk-'),     'must not embed sk- secret prefix');
  });

  it('demo does not reference deprecated /llm-sor endpoint', () => {
    assert.ok(!html.includes('/llm-sor'), 'must not reference /llm-sor');
  });
});
