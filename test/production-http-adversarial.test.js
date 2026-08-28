'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const MAX_UPLOAD_BODY = 1_048_576;

function waitForServer(child, stdout, marker = 'HTTP_READY ') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`server did not become ready; output:\n${stdout.value}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout.value += chunk;
      const line = stdout.value.split('\n').find((entry) => entry.startsWith(marker));
      if (!line) return;
      clearTimeout(timer);
      finish(resolve, JSON.parse(line.slice(marker.length)));
    });
    child.stderr.on('data', (chunk) => { stdout.stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      finish(reject, error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) finish(reject, new Error(`server exited ${code || signal}; output:\n${stdout.value}\n${stdout.stderr}`));
    });
  });
}

async function bootServer(t) {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-http-adversarial-'));
  const childScript = `
    const server = require(${JSON.stringify(path.join(repoRoot, 'server.js'))});
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('HTTP_READY ' + JSON.stringify({ port: server.address().port }) + '\\n');
    });
  `;
  const output = { value: '', stderr: '' };
  const child = spawn(process.execPath, ['-e', childScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HUQAN_DISABLE_AUTO_LISTEN: '1',
      HUQAN_API_KEY: 'test-key',
      HUQAN_MEMORY_PATH: path.join(caseDir, 'memory.json'),
      HUQAN_DB_PATH: path.join(caseDir, 'graph.sqlite'),
      HUQAN_LOAD_PLUGINS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await waitForServer(child, output);
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(caseDir, { recursive: true, force: true });
  });
  return { child, port: ready.port, output };
}

function parseResponse(raw) {
  const [headerText, body = ''] = raw.split('\r\n\r\n');
  const statusLine = headerText.split('\r\n', 1)[0];
  const status = Number(statusLine.split(' ')[1]);
  return { status, headers: headerText, body };
}

function sendRaw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let raw = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw HTTP request timed out'));
    }, 10_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(parseResponse(raw));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function jsonRequest({ method = 'POST', pathName = '/api/ingest', body = '', apiKey = 'test-key', contentLength = Buffer.byteLength(body), transferEncoding = false }) {
  const headers = [
    `${method} ${pathName} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
  ];
  if (apiKey !== null) headers.push(`X-API-Key: ${apiKey}`);
  if (transferEncoding) headers.push('Transfer-Encoding: chunked');
  else headers.push(`Content-Length: ${contentLength}`);
  headers.push('', '');
  return headers.join('\r\n') + (transferEncoding
    ? `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`
    : body);
}

test('real TCP auth rejection happens before ingest mutation', async (t) => {
  const { port } = await bootServer(t);
  const response = await sendRaw(port, jsonRequest({ apiKey: null, body: JSON.stringify({ claim: 'unauthorized' }) }));
  assert.equal(response.status, 401);
  assert.match(response.body, /Unauthorized|API key/i);
});

test('real TCP Content-Length overflow returns a clean 413 without reading a body', async (t) => {
  const { port } = await bootServer(t);
  const response = await sendRaw(port, jsonRequest({ contentLength: MAX_UPLOAD_BODY + 1 }));
  assert.equal(response.status, 413);
  assert.match(response.body, /Payload too large/i);
});

test('real TCP chunked overflow returns 413 and malformed JSON returns 400', async (t) => {
  const { port } = await bootServer(t);
  const oversized = 'x'.repeat(MAX_UPLOAD_BODY + 1);
  const overflow = await sendRaw(port, jsonRequest({ body: JSON.stringify({ claim: oversized }), transferEncoding: true }));
  assert.equal(overflow.status, 413);
  assert.match(overflow.body, /Payload too large/i);

  const malformed = await sendRaw(port, jsonRequest({ body: '{"claim":' }));
  assert.equal(malformed.status, 400);
  assert.match(malformed.body, /Invalid JSON/i);
});
