const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const PORT = 34567;
const BASE = `http://localhost:${PORT}`;
let server;

before(() => {
  process.env.PORT = String(PORT);
  server = require('./server');
  server.unref();
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

describe('Server - API', () => {
  it('GET /api?q=... döndürür', async () => {
    const r = await fetch(`${BASE}/api?q=merhaba`);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok('result' in j);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  });

  it('GET /api boş q hata döndürür', async () => {
    const r = await fetch(`${BASE}/api?q=`);
    assert.strictEqual(r.status, 400);
  });

  it('GET /dogrula?statement=... çalışır', async () => {
    const r = await fetch(`${BASE}/dogrula?statement=kedi+balık+yer`);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok('status' in j);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  });

  it('GET /dogrula boş statement hata döndürür', async () => {
    const r = await fetch(`${BASE}/dogrula?statement=`);
    assert.strictEqual(r.status, 400);
  });

  it('POST /dogrula JSON body ile çalışır', async () => {
    const r = await fetch(`${BASE}/dogrula`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'kedi hayvandır' }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok('status' in j);
  });

  it('POST /dogrula boş body hata döndürür', async () => {
    const r = await fetch(`${BASE}/dogrula`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(r.status, 400);
  });

  it('POST /yukle metin öğrenir', async () => {
    const r = await fetch(`${BASE}/yukle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test-node test-edge-eder' }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.ok(j.learned > 0);
  });

  it('POST /yukle boş body hata döndürür', async () => {
    const r = await fetch(`${BASE}/yukle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(r.status, 400);
  });

  it('POST /llm-sor soru gönderir', async () => {
    const r = await fetch(`${BASE}/llm-sor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'kedi nedir' }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok('ok' in j);
    assert.ok('llmAnswer' in j || 'error' in j);
  });

  it('POST /llm-sor boş question hata döndürür', async () => {
    const r = await fetch(`${BASE}/llm-sor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(r.status, 400);
  });

  it('POST /llm-sor geçersiz JSON hata döndürür', async () => {
    const r = await fetch(`${BASE}/llm-sor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    assert.strictEqual(r.status, 400);
  });

  it('GET /graph-data döndürür', async () => {
    const r = await fetch(`${BASE}/graph-data`);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.nodes));
    assert.ok(Array.isArray(j.links));
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(r.headers.get('cache-control'), 'no-cache');
  });

  it('GET / HTML döndürür', async () => {
    const r = await fetch(`${BASE}`);
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('AXIOM'));
    assert.ok(html.includes('d3@7'));
    assert.ok(html.includes('forceSimulation'));
  });

  it('bilinmeyen rota 404 döndürür', async () => {
    const r = await fetch(`${BASE}/yok-boyle-bir-rota`);
    assert.strictEqual(r.status, 404);
  });

  it('Method not allowed: POST /api', async () => {
    const r = await fetch(`${BASE}/api`, { method: 'POST' });
    assert.strictEqual(r.status, 405);
  });

  it('Method not allowed: PUT /graph-data', async () => {
    const r = await fetch(`${BASE}/graph-data`, { method: 'PUT' });
    assert.strictEqual(r.status, 405);
  });

  it('GET /api async komutlarda Promise sızdırmaz', async () => {
    const originalExecute = server && require('./cli').prototype.execute;
    const CLI = require('./cli');
    CLI.prototype.execute = () => Promise.resolve('async-ok');
    try {
      const r = await fetch(`${BASE}/api?q=merhaba`);
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(j.result, 'async-ok');
    } finally {
      CLI.prototype.execute = originalExecute;
    }
  });
});
