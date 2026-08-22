'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const CLIENT = path.join(__dirname, '..', 'scripts', 'external-client.js');
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, ...args], {
      env: { ...process.env, HUQAN_API_KEY: 'test-key', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', status => resolve({ status, stdout, stderr }));
  });
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function clientArgs(directory, port, name) {
  const input = path.join(directory, `${name}-input.json`);
  const output = path.join(directory, `${name}-output.json`);
  fs.writeFileSync(input, JSON.stringify({ package: {}, signature: {} }));
  return {
    args: ['admit', '--url', `http://127.0.0.1:${port}/admit`, '--input', input, '--output', output],
    output,
  };
}

test('external client times out when an admitted server never responds', { timeout: 25_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-external-client-timeout-'));
  const server = await listen(request => request.resume());
  t.after(async () => { await close(server); fs.rmSync(directory, { recursive: true, force: true }); });
  const { port } = server.address();
  const { args, output } = clientArgs(directory, port, 'timeout');
  const started = Date.now();
  const result = await run(args);

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`HTTP request timed out after ${REQUEST_TIMEOUT_MS}ms`));
  assert.ok(Date.now() - started < REQUEST_TIMEOUT_MS + 5_000);
  assert.equal(fs.existsSync(output), false);
});

test('external client rejects a response once it exceeds its byte budget', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-external-client-size-'));
  const server = await listen((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(Buffer.alloc(RESPONSE_MAX_BYTES + 1, 0x61));
  });
  t.after(async () => { await close(server); fs.rmSync(directory, { recursive: true, force: true }); });
  const { port } = server.address();
  const { args, output } = clientArgs(directory, port, 'size');
  const result = await run(args);

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`HTTP response exceeded ${RESPONSE_MAX_BYTES} byte limit`));
  assert.equal(fs.existsSync(output), false);
});
