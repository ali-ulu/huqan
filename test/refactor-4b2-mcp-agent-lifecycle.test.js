'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const AxiomStorage = require('../storage');
const Kernel = require('../kernel');
const { createServer } = require('../mcpServer');

function createFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-4b2-${label}-`));
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  const server = createServer({ kernel, approvalStore: null });
  return { root, kernel, server };
}

function callTool(server, name, args = {}) {
  const response = server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  assert.ok(response.result, `${name} must return a JSON-RPC result`);
  return response.result;
}

function closeFixture(fixture) {
  try { fixture.kernel.graph.close(); } catch (_) {}
  try { fixture.kernel.memory.close(); } catch (_) {}
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test('MCP read tools do not allocate an unused Agent storage backend', { concurrency: false }, () => {
  const fixture = createFixture('read');
  const originalClose = AxiomStorage.prototype.close;
  let closeCount = 0;
  AxiomStorage.prototype.close = function closeInstrumentedStorage() {
    closeCount += 1;
    return originalClose.call(this);
  };
  try {
    const verify = callTool(fixture.server, 'axiom.verify', { statement: 'unknown claim' });
    const ask = callTool(fixture.server, 'axiom.ask', { question: 'unknown subject' });
    assert.equal(verify.isError, false);
    assert.equal(verify.structuredContent.data.status, 'bilinmiyor');
    assert.equal(ask.isError, false);
    assert.equal(closeCount, 0);
    assert.equal(fs.existsSync(path.join(fixture.root, 'memory.db')), false);
  } finally {
    AxiomStorage.prototype.close = originalClose;
    closeFixture(fixture);
  }
});

test('MCP agent-backed tools close their per-call storage before returning', { concurrency: false }, () => {
  const fixture = createFixture('agent');
  const originalClose = AxiomStorage.prototype.close;
  let closeCount = 0;
  AxiomStorage.prototype.close = function closeInstrumentedStorage() {
    closeCount += 1;
    return originalClose.call(this);
  };
  try {
    const plan = callTool(fixture.server, 'axiom.plan', { goal: 'verify a claim', maxSteps: 1 });
    assert.equal(plan.isError, false);
    assert.equal(plan.structuredContent.ok, true);

    const policy = callTool(fixture.server, 'axiom.policy', {
      tool: 'internal.verify',
      input: 'verify a claim',
    });
    assert.equal(policy.isError, false);

    const dryRun = callTool(fixture.server, 'axiom.agent', { goal: 'verify a claim', maxSteps: 1 });
    assert.equal(dryRun.isError, false);
    assert.equal(dryRun.structuredContent.dryRun, true);
    assert.equal(closeCount, 3);
  } finally {
    AxiomStorage.prototype.close = originalClose;
    closeFixture(fixture);
  }
});
