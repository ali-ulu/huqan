'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

function waitForReady(child, output) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server readiness timeout: ${output.stderr}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      output.stdout += chunk;
      const match = output.stdout.match(/READY (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    child.once('error', reject);
  });
}

function slowHeader(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('slow-header connection outlived its deadline'));
    }, 5_000);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: '));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

test('production server expires incomplete headers through the real TCP parser', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-slow-header-regression-'));
  const output = { stdout: '', stderr: '' };
  const script = `
    const server = require(${JSON.stringify(path.join(repoRoot, 'server.js'))});
    server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));
  `;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HUQAN_DISABLE_AUTO_LISTEN: '1',
      HUQAN_API_KEY: 'timeout-regression-secret',
      HUQAN_HEADERS_TIMEOUT_MS: '1000',
      HUQAN_REQUEST_TIMEOUT_MS: '2000',
      HUQAN_KEEP_ALIVE_TIMEOUT_MS: '500',
      HUQAN_MEMORY_PATH: path.join(root, 'memory.json'),
      HUQAN_DB_PATH: path.join(root, 'memory.db'),
      HUQAN_LOAD_PLUGINS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const port = await waitForReady(child, output);
  const responses = await Promise.all(Array.from({ length: 64 }, () => slowHeader(port)));
  assert.ok(responses.every((response) => response.startsWith('HTTP/1.1 408 Request Timeout')));
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(output.stdout + output.stderr, /timeout-regression-secret/);
});

