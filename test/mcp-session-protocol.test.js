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
  createCancellationTracker,
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
  // A call that threw may have written first: the receipt does not claim it did not.
  assert.equal(receipts[0].canonicalWrite, 'unknown');
  assert.equal(receipts[0].reason, null);
});

test('only a well-formed notification cancels', async () => {
  const receipts = [];
  const work = deferred();
  const handle = createJsonRpcHandler({
    callTool: () => work.promise,
    recordCancellation: (operationId, receipt) => receipts.push(receipt),
  });
  const pending = handle({ jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: { name: 'huqan.agent' } });
  const asRequest = handle({ jsonrpc: '2.0', id: 99, method: 'notifications/cancelled', params: { requestId: 'call-2' } });
  assert.equal(asRequest.error.code, -32600, 'a cancellation with an id is a malformed request');
  assert.equal(handle({ jsonrpc: '1.0', method: 'notifications/cancelled', params: { requestId: 'call-2' } }), null);
  assert.equal(handle({ method: 'notifications/cancelled', params: { requestId: 'call-2' } }), null);
  work.resolve({ ok: true });
  assert.equal((await pending).result.isError, false, 'the call was not cancelled');
  assert.equal(receipts.length, 0);
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

test('a cancelled call that outlives the deadline is receipted as unsettled, then settled', async () => {
  const receipts = [];
  const tracker = createCancellationTracker({
    sessionId: 'session-x',
    writeReceipt: (operationId, receipt) => receipts.push({ operationId, receipt }),
    settleDeadlineMs: 5,
  });
  const work = deferred();
  const answered = tracker.track('hung', 'huqan.agent', work.promise, () => 'response', () => 'failure');
  tracker.cancel({ requestId: 'hung', reason: 'gave up' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(tracker.inFlightCount(), 0, 'a hung call does not keep its entry');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operationId, 'mcp:cancellation:session-x:s:hung');
  assert.equal(receipts[0].receipt.outcome, 'unsettled');
  assert.equal(receipts[0].receipt.canonicalWrite, 'unknown');

  work.resolve({ ok: true, canonicalWrite: true, receiptId: 'late-1' });
  assert.equal(await answered, null, 'still not answered');
  assert.equal(receipts.length, 2);
  assert.equal(receipts[1].operationId, 'mcp:cancellation:session-x:s:hung:settled');
  assert.equal(receipts[1].receipt.outcome, 'completed');
  assert.equal(receipts[1].receipt.canonicalWrite, true);
  assert.equal(receipts[1].receipt.receiptId, 'late-1');
});

test('a completed result that does not state its write is receipted as unknown', async () => {
  const receipts = [];
  const tracker = createCancellationTracker({
    sessionId: 's', writeReceipt: (id, receipt) => receipts.push(receipt), settleDeadlineMs: 5,
  });
  const work = deferred();
  const answered = tracker.track(1, 'huqan.search', work.promise, () => 'response', () => 'failure');
  tracker.cancel({ requestId: 1 });
  work.resolve({ ok: true });
  assert.equal(await answered, null);
  assert.equal(receipts[0].canonicalWrite, 'unknown');
  assert.equal(tracker.inFlightCount(), 0);
  // The deadline of a call that settled in time never fires a second receipt.
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(receipts.length, 1);
});

test('a duplicate in-flight id is answered but only the first call is cancellable', async () => {
  const receipts = [];
  const first = deferred();
  const second = deferred();
  let call = 0;
  const handle = createJsonRpcHandler({
    callTool: () => (call++ === 0 ? first.promise : second.promise),
    recordCancellation: (operationId, receipt) => receipts.push(receipt),
  });
  const a = handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'one' } });
  const b = handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'two' } });
  handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
  first.resolve({ ok: true });
  second.resolve({ ok: true });
  assert.equal(await a, null);
  assert.equal((await b).result.isError, false);
  assert.deepEqual(receipts.map(receipt => receipt.tool), ['one']);
});

test('initialize is answered at once and cannot be cancelled', () => {
  const handle = createJsonRpcHandler({ callTool: () => ({}) });
  const init = handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} });
  assert.equal(typeof init.then, 'undefined');
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'init' } }), null);
});

test('a receipt sink that rejects asynchronously is reported, not left unhandled', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  const work = deferred();
  try {
    const handle = createJsonRpcHandler({
      callTool: () => work.promise,
      recordCancellation: () => Promise.reject(new Error('journal offline')),
    });
    const pending = handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'huqan.dream' } });
    handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } });
    work.resolve({ ok: true });
    assert.equal(await pending, null);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.error = original;
  }
  assert.ok(logged.some(args => args.some(arg => arg && /journal offline/.test(arg.message) && arg.receipt)));
});

async function cancelOnce(handlerOptions, settleWith) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  const work = deferred();
  try {
    const handle = createJsonRpcHandler({ callTool: () => work.promise, ...handlerOptions });
    const pending = handle({ jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'huqan.dream' } });
    handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'x' } });
    settleWith(work);
    assert.equal(await pending, null);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.error = original;
  }
  return logged.flat().filter(arg => arg && arg.receipt);
}

test('without a receipt sink, or with one that rejects without a reason, the receipt reaches stderr', async () => {
  const noSink = await cancelOnce({}, work => work.resolve({ ok: true }));
  assert.equal(noSink.length, 1);
  assert.match(noSink[0].message, /no cancellation receipt sink/);
  const bare = await cancelOnce({ recordCancellation: () => Promise.reject() }, work => work.resolve({ ok: true }));
  assert.equal(bare.length, 1);
  assert.match(bare[0].message, /receipt not written: undefined/);
});

test('the receipt names the error code a call ended with', async () => {
  const receipts = [];
  const sink = { recordCancellation: (operationId, receipt) => receipts.push(receipt) };
  await cancelOnce(sink, work => work.reject(new Error('no code')));
  await cancelOnce(sink, work => work.resolve({ ok: false, error: { code: 'DREAM_FAILED', message: 'm' } }));
  assert.equal(receipts[0].errorCode, 'INTERNAL_ERROR', 'a failure without a code');
  assert.equal(receipts[1].errorCode, 'DREAM_FAILED', 'a completed refusal keeps its code');
  assert.equal(receipts[1].outcome, 'completed');
});

test('createServer without a kernel mutation journal still withholds a cancelled call', async () => {
  const kernels = {
    'no graph': {
      runCapability: async () => ({ ok: true, type: 'advocate', data: { mode: 'counter', counterArguments: [] }, evidence: [], error: null, meta: {} }),
    },
    'a graph with no journal': {
      graph: { getNodes: () => ({}) },
      runCapability: async () => ({ ok: true, type: 'advocate', data: { mode: 'counter', counterArguments: [] }, evidence: [], error: null, meta: {} }),
    },
  };
  const { createServer } = require('../mcpServer');
  for (const [label, kernel] of Object.entries(kernels)) {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args);
    try {
      const server = createServer({ kernel, approvalStore: null });
      const pending = server.handleRequest({
        jsonrpc: '2.0', id: 'adv', method: 'tools/call', params: { name: 'huqan.advocate', arguments: { workspaceId: 'default', claim: 'x' } },
      });
      assert.equal(typeof pending.then, 'function', label);
      server.handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'adv' } });
      assert.equal(await pending, null, label);
    } finally {
      console.error = original;
    }
    assert.ok(logged.flat().some(arg => arg && /no mutation journal/.test(arg.message) && arg.receipt), label);
  }
});
