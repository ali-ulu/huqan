'use strict';
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { checkRateLimit, requireApiKey, rateLimitMap } = require('../../requestGuards');
const { EXTERNAL_CLIENT_ENDPOINT_PATH } = require('../../lib/external-client-endpoint-contract');
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
  });
}
function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}
function sendHttp({ port, method = 'POST', route = EXTERNAL_CLIENT_ENDPOINT_PATH, headers = {}, body = '', chunks }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (response) => {
      const buffers = [];
      response.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
      response.on('end', () => {
        const raw = Buffer.concat(buffers).toString('utf8');
        let parsed = raw;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed, raw });
      });
    });
    request.on('error', reject);
    if (chunks) { for (const chunk of chunks) request.write(chunk); }
    else if (body) request.write(body);
    request.end();
  });
}
async function createRouteHarness({ adapter, apiKey = 'route-api-key', maxRequests = 120, now = Date.now() }) {
  const rateKey = `route-${randomUUID()}`;
  let adapterCalls = 0;
  const server = http.createServer(async (request, response) => {
    if (!checkRateLimit(rateKey, now, 60_000, maxRequests)) {
      response.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }
    const authentication = requireApiKey(request, apiKey);
    if (!authentication.ok) {
      response.writeHead(authentication.status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', ...authentication.headers });
      response.end(JSON.stringify(authentication.error));
      return;
    }
    if (request.url !== EXTERNAL_CLIENT_ENDPOINT_PATH) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    adapterCalls += 1;
    const descriptor = await adapter.handle(request);
    response.writeHead(descriptor.statusCode, descriptor.headers);
    response.end(JSON.stringify(descriptor.body));
  });
  const port = await listen(server);
  return {
    port, apiKey, rateKey,
    get adapterCalls() { return adapterCalls; },
    send(options = {}) {
      const body = options.body === undefined ? '' : options.body;
      const headers = { ...(options.headers || {}) };
      if (options.authorized !== false) headers.authorization = `Bearer ${options.key || apiKey}`;
      if (body && options.contentLength !== false && headers['content-length'] === undefined) {
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      return sendHttp({ port, method: options.method, route: options.route, headers, body, chunks: options.chunks });
    },
    async close() { await close(server); rateLimitMap.delete(rateKey); },
  };
}
function probeRealServer(configurationValue) {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', '..', 'server.js');
    const source = `
      'use strict';
      const http = require('node:http');
      process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
      process.env.AXIOM_USE_SQLITE = 'false';
      process.env.AXIOM_MEMORY_PATH = process.argv[2];
      process.env.AXIOM_EXTERNAL_CLIENT_ENDPOINT_ENABLED = process.argv[3];
      const server = require(process.argv[1]);
      server.startServer(0, '127.0.0.1').once('listening', () => {
        const port = server.address().port;
        const req = http.request({ hostname: '127.0.0.1', port,
          path: '/api/external-client/packages/admit', method: 'POST',
          headers: { 'content-type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => server.close(() => {
            try { server.closeAxiom(); } catch (_) {}
            process.stdout.write(JSON.stringify({ statusCode: res.statusCode,
              body: Buffer.concat(chunks).toString('utf8') }));
          }));
        });
        req.on('error', (error) => { process.stderr.write(error.stack); process.exitCode = 1; });
        req.end('{}');
      });
    `;
    const memoryPath = path.join(process.cwd(), `.route-server-${randomUUID()}.json`);
    const child = spawn(process.execPath, ['-e', source, serverPath, memoryPath, String(configurationValue)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      try { require('node:fs').rmSync(memoryPath, { force: true }); } catch (_) {}
      if (code !== 0) return reject(new Error(stderr || `real server probe exited ${code}`));
      const match = stdout.match(/\{\"statusCode\"[\s\S]*\}$/);
      if (!match) return reject(new Error(`real server probe produced no result: ${stdout}`));
      resolve(JSON.parse(match[0]));
    });
  });
}
module.exports = { createRouteHarness, sendHttp, probeRealServer };
