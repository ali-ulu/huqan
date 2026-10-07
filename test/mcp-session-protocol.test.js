'use strict';

// #3484: initialize reads the client's version and capabilities, a version
// mismatch is answered per the MCP lifecycle instead of refused, the
// implemented surface is published and held to the live handler, and an
// in-flight tools/call can be cancelled with a receipt that says how it ended.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createJsonRpcHandler } = require('../lib/mcp/json-rpc-handler');
const {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  IMPLEMENTED_SURFACE,
  negotiateInitialize,
} = require('../lib/mcp/session-protocol');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.error = original; });
}

test('a supported version is echoed and a mismatch falls back without an error', () => {
  const handle = createJsonRpcHandler({ callTool: () => ({}) });
  const echoed = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
  assert.equal(echoed.error, undefined);
  assert.equal(echoed.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.deepEqual(echoed.result._meta.negotiation.matched, true);

  for (const requested of ['2024-11-05', '2025-03-26', '2026-07-28', 'garbage']) {
    const answer = handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: requested } });
    assert.equal(answer.error, undefined, `${requested} is not refused`);
    assert.equal(answer.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(answer.result._meta.negotiation.requestedVersion, requested);
    assert.equal(answer.result._meta.negotiation.matched, false);
  }
  for (const params of [undefined, null, {}, { protocolVersion: 7 }, { protocolVersion: 'x'.repeat(33) }]) {
    const answer = handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params });
    assert.equal(answer.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(answer.result._meta.negotiation.requestedVersion, null);
  }
});

test('client capabilities and identity are read, bounded and reported', () => {
  const negotiated = negotiateInitialize({
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
    clientInfo: { name: 'claude-code', version: '2.1.0' },
  });
  assert.deepEqual(negotiated.clientCapabilities, { roots: true, rootsListChanged: true, sampling: true, elicitation: true });
  assert.deepEqual(negotiated.clientInfo, { name: 'claude-code', version: '2.1.0' });

  const hostile = negotiateInitialize({
    capabilities: { roots: true, sampling: 'yes', elicitation: [] },
    clientInfo: { name: 'n'.repeat(129), version: 3 },
  });
  assert.deepEqual(hostile.clientCapabilities, { roots: false, rootsListChanged: false, sampling: false, elicitation: false });
  assert.deepEqual(hostile.clientInfo, { name: null, version: null });
  assert.deepEqual(negotiateInitialize('nope').clientCapabilities.roots, false);
});

test('the published implemented surface matches what the handler answers', () => {
  const handle = createJsonRpcHandler({ callTool: () => ({ ok: true }) });
  const init = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.deepEqual(init.result._meta.implementedSurface, IMPLEMENTED_SURFACE);
  assert.deepEqual(IMPLEMENTED_SURFACE.protocolVersions, SUPPORTED_PROTOCOL_VERSIONS);
  // Advertised capabilities are exactly the implemented ones.
  assert.deepEqual(Object.keys(init.result.capabilities), ['tools']);
  assert.equal(init.result.capabilities.tools.listChanged, IMPLEMENTED_SURFACE.tools.listChanged);
  assert.ok(Array.isArray(handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools));
  const unimplemented = {
    resources: 'resources/list', prompts: 'prompts/list', logging: 'logging/setLevel', completions: 'completion/complete',
  };
  for (const [feature, method] of Object.entries(unimplemented)) {
    assert.equal(IMPLEMENTED_SURFACE[feature], false);
    assert.equal(handle({ jsonrpc: '2.0', id: 3, method }).error.code, -32601, `${method} is not implemented`);
  }
});

test('a cancelled in-flight call gets no response and a receipt of how it ended', async () => {
  const receipts = [];
  const work = deferred();
  let workFinished = false;
  const handle = createJsonRpcHandler({
    callTool: () => work.promise.then((value) => { workFinished = true; return value; }),
    recordCancellation: (operationId, receipt) => receipts.push({ operationId, receipt }),
  });

  const pending = handle({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'huqan.learn', arguments: {} } });
  assert.equal(handle({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1', reason: 'user aborted' },
  }), null, 'a notification is never answered');
  // A repeated cancellation does not rewrite the first one's reason.
  handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1', reason: 'second thoughts' } });
  assert.equal(receipts.length, 0, 'the receipt waits for the call to settle');

  work.resolve({ ok: true, canonicalWrite: true, receiptId: 'rcpt-9' });
  assert.equal(await pending, null, 'a cancelled call is not answered');
  assert.equal(workFinished, true, 'running work is not interrupted');
  assert.equal(receipts.length, 1);
  assert.match(receipts[0].operationId, /^mcp:cancellation:[0-9a-f-]{36}:s:call-1$/);
  assert.deepEqual({ ...receipts[0].receipt, sessionId: '<session>' }, {
    kind: 'mcp.tools_call.cancelled',
    sessionId: '<session>',
    requestId: 'call-1',
    tool: 'huqan.learn',
    reason: 'user aborted',
    outcome: 'completed',
    canonicalWrite: true,
    receiptId: 'rcpt-9',
    errorCode: null,
  });
});

test('a cancelled call that fails is receipted as failed', async () => {
  const receipts = [];
  const work = deferred();
  const handle = createJsonRpcHandler({
    callTool: () => work.promise,
    recordCancellation: (operationId, receipt) => receipts.push(receipt),
  });
  const pending = handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'huqan.agent' } });
  handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
  work.reject(Object.assign(new Error('boom'), { code: 'AGENT_FAILED' }));
  assert.equal(await quietly(() => pending), null);
  assert.equal(receipts[0].outcome, 'failed');
  assert.equal(receipts[0].errorCode, 'AGENT_FAILED');
  assert.equal(receipts[0].canonicalWrite, false);
  assert.equal(receipts[0].reason, null);
});

test('unknown, finished and synchronous calls ignore cancellation', async () => {
  const receipts = [];
  const work = deferred();
  const handle = createJsonRpcHandler({
    callTool: params => (params.name === 'sync' ? { ok: true } : work.promise),
    recordCancellation: (operationId, receipt) => receipts.push(receipt),
  });
  const sync = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sync' } });
  assert.equal(sync.result.isError, false);
  handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });

  const pending = handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'async' } });
  work.resolve({ ok: true });
  assert.equal((await pending).result.isError, false);
  for (const params of [{ requestId: 2 }, { requestId: 'never' }, { requestId: {} }, undefined, null]) {
    assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params }), null);
  }
  assert.equal(receipts.length, 0);
});

test('a receipt that cannot be written still withholds the response', async () => {
  const work = deferred();
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const handle = createJsonRpcHandler({
      callTool: () => work.promise,
      recordCancellation: () => { throw new Error('journal unavailable'); },
    });
    const pending = handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'huqan.dream' } });
    handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    work.resolve({ ok: true });
    assert.equal(await pending, null);
  } finally {
    console.error = original;
  }
  assert.ok(logged.some(args => args.some(arg => arg && arg.receipt && arg.receipt.tool === 'huqan.dream')),
    'the unwritten receipt reaches stderr');
});

test('createServer persists the cancellation receipt in the kernel mutation journal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-cancel-'));
  const Kernel = require('../kernel');
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(root, 'memory.json') });
  const { createServer } = require('../mcpServer');
  const server = createServer({ kernel, approvalStore: null });
  t.after(() => {
    server.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // huqan.search answers through the asynchronous read workflow, so it is
  // in flight when the cancellation arrives.
  const pending = server.handleRequest({
    jsonrpc: '2.0', id: 'search-1', method: 'tools/call', params: { name: 'huqan.search', arguments: { workspaceId: 'default', query: 'kedi' } },
  });
  assert.equal(typeof pending.then, 'function');
  server.handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'search-1', reason: 'closed tab' } });
  assert.equal(await quietly(() => pending), null);

  const journal = kernel.graph.getCommittedMutationResultsByPrefix('mcp:cancellation:');
  assert.equal(journal.length, 1);
  assert.equal(journal[0].result.kind, 'mcp.tools_call.cancelled');
  assert.equal(journal[0].result.tool, 'huqan.search');
  assert.equal(journal[0].result.reason, 'closed tab');
  assert.equal(journal[0].result.outcome, 'completed');
});

test('stdio writes nothing for a call that settles without a response', () => {
  // A child process with real stdin/stdout: replacing process.stdout inside a
  // node:test worker would also swallow the runner's own reporting.
  const { spawnSync } = require('node:child_process');
  const transport = path.join(__dirname, '..', 'lib', 'mcp', 'stdio-transport.js');
  const script = `require(${JSON.stringify(transport)}).serveStdio({
    handleRequest: m => Promise.resolve(m.id === 'cancelled' ? null : { jsonrpc: '2.0', id: m.id, result: {} }),
  });`;
  const input = [
    { jsonrpc: '2.0', id: 'cancelled', method: 'tools/call' },
    { jsonrpc: '2.0', id: 'answered', method: 'tools/call' },
  ].map(message => `${JSON.stringify(message)}\n`).join('');
  const child = spawnSync(process.execPath, ['-e', script], { input, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(child.stdout.trim().split('\n'), ['{"jsonrpc":"2.0","id":"answered","result":{}}']);
});
