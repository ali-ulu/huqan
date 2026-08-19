const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_KEY = 'request-body-transport-test-key';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-request-body-'));
process.env.AXIOM_API_KEY = API_KEY;
process.env.AXIOM_USE_SQLITE = 'false';
process.env.AXIOM_MEMORY_PATH = path.join(tmpDir, 'memory.json');
process.env.AXIOM_DB_PATH = path.join(tmpDir, 'memory.db');

const { DEFAULT_MAX_JSON_BODY } = require('../requestGuards');
const server = require('../server');

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close() {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function request(agent, port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent,
      host: '127.0.0.1',
      port,
      path: options.path || '/verify',
      method: options.method || 'POST',
      headers: options.headers || {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        complete: res.complete,
      }));
    });
    req.on('error', reject);
    if (options.chunks) {
      for (const chunk of options.chunks) req.write(chunk);
    }
    req.end(options.body);
  });
}

test('chunked JSON overflow returns HTTP 413 and preserves the keep-alive connection (#713)', async (t) => {
  const port = await listen();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    agent.destroy();
    await close();
    try { server.closeHuqan(); } catch (_) {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const overflow = await request(agent, port, {
    chunks: [Buffer.alloc(DEFAULT_MAX_JSON_BODY), Buffer.from('x')],
  });
  assert.equal(overflow.status, 413);
  assert.deepEqual(JSON.parse(overflow.body), { error: 'Payload too large' });
  assert.equal(overflow.complete, true);

  const health = await request(agent, port, { method: 'GET', path: '/health' });
  assert.equal(health.status, 200);
  assert.equal(health.complete, true);
});
