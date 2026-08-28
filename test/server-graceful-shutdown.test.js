'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-server-shutdown-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function runServerUntilSignal(signal) {
  return new Promise((resolve, reject) => {
    const memoryPath = path.join(root, `${signal}.memory.json`);
    const dbPath = path.join(root, `${signal}.db`);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        HUQAN_MEMORY_PATH: memoryPath,
        HUQAN_DB_PATH: dbPath,
        HUQAN_USE_SQLITE: 'false',
        HUQAN_HOST: '127.0.0.1',
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let requestStarted = false;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      reject(new Error(`server did not become ready within 5 seconds; stdout=${stdout}; stderr=${stderr}`));
    }, 5_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (requestStarted) return;
      const match = stdout.match(/HUQAN web interface: http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      requestStarted = true;
      const request = http.get({ hostname: '127.0.0.1', port: Number(match[1]), path: '/health' }, (response) => {
        response.resume();
        response.once('end', () => {
          assert.equal(response.statusCode, 200, `${signal} health probe failed`);
          child.kill(signal);
        });
      });
      request.once('error', (error) => {
        if (settled) return;
        clearTimeout(timeout);
        settled = true;
        child.kill('SIGKILL');
        reject(error);
      });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });
    child.once('close', (code, receivedSignal) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      resolve({ code, receivedSignal, stdout, stderr });
    });
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`server exits cleanly after ${signal}`, async () => {
    const result = await runServerUntilSignal(signal);
    assert.equal(result.code, 0, `${signal} exit code; stderr=${result.stderr}`);
    assert.equal(result.receivedSignal, null, `${signal} should be handled by graceful shutdown`);
    assert.match(result.stdout, /HUQAN web interface: http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(result.stderr, /graceful_shutdown_error|GRACEFUL_SHUTDOWN_FAILED/, `${signal} emitted a shutdown failure`);
  });
}
