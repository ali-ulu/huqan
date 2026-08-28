'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const { createMcpServerCloser } = require('../lib/mcp/server-lifecycle');

function startMcpProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-process-'));
  const child = spawn(process.execPath, [path.join(repoRoot, 'mcpServer.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HUQAN_MEMORY_PATH: path.join(root, 'memory.json'),
      HUQAN_DB_PATH: path.join(root, 'memory.db'),
      HUQAN_MCP_CAPABILITY_NONCE_DIR: path.join(root, 'nonces'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const parseErrors = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { lines.push(JSON.parse(line)); } catch (_) { parseErrors.push(line); }
    }
  });
  child.stderr.on('data', () => {});
  return { child, lines, parseErrors, root };
}

function waitForLine(lines, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const match = lines.find(predicate);
      if (match) return resolve(match);
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for MCP response'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode, signal: null });
    const timer = setTimeout(() => reject(new Error('MCP process did not exit')), timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('real MCP stdio process closes owned persistence resources on shutdown', async (t) => {
  const { child, lines, parseErrors, root } = startMcpProcess();
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  const initialized = await waitForLine(lines, (message) => message.id === 1);
  assert.equal(initialized.result.serverInfo.name, 'huqan');

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const tools = await waitForLine(lines, (message) => message.id === 2);
  assert.ok(Array.isArray(tools.result.tools));

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: { padding: 'x'.repeat(70 * 1024) } })}\n`);
  const oversized = await waitForLine(lines, (message) => message.id === null && message.error?.code === -32600);
  assert.match(oversized.error.message, /frame exceeds protocol limit/);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })}\n`);
  const pong = await waitForLine(lines, (message) => message.id === 4);
  assert.deepEqual(pong.result, {});

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'shutdown' })}\n`);
  const shutdown = await waitForLine(lines, (message) => message.id === 5);
  assert.deepEqual(shutdown.result, {});
  const exited = await waitForExit(child);
  assert.equal(exited.code, 0);
  assert.deepEqual(parseErrors, []);
  const database = new Database(path.join(root, 'memory.db'));
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
});

test('owned MCP resources close once and surface cleanup failures', () => {
  let kernelCloses = 0;
  let approvalCloses = 0;
  let nonceCloses = 0;
  const close = createMcpServerCloser({
    kernel: { graph: { close() { kernelCloses += 1; } } },
    approvalStore: { close() { approvalCloses += 1; throw new Error('approval close failed'); } },
    operatorCapabilityNonces: { close() { nonceCloses += 1; } },
    ownsKernel: true,
    ownsApprovalStore: true,
    ownsOperatorCapabilityNonces: true,
  });

  assert.throws(() => close(), error => error instanceof AggregateError
    && error.errors.length === 1 && error.errors[0].message === 'approval close failed');
  close();

  assert.equal(kernelCloses, 1);
  assert.equal(approvalCloses, 1);
  assert.equal(nonceCloses, 1);
});

test('createServer does not close caller-owned kernel, approval store, or nonce store', () => {
  const mcpServer = require('../mcpServer');
  let kernelCloses = 0;
  let approvalCloses = 0;
  let nonceCloses = 0;
  const kernel = {
    learn() {},
    graph: { close() { kernelCloses += 1; } },
  };
  const approvalStore = { close() { approvalCloses += 1; } };
  const operatorCapabilityNonces = { close() { nonceCloses += 1; } };
  const server = mcpServer.createServer({ kernel, approvalStore, operatorCapabilityNonces });

  server.close();
  server.close();

  assert.equal(kernelCloses, 0);
  assert.equal(approvalCloses, 0);
  assert.equal(nonceCloses, 0);
});
