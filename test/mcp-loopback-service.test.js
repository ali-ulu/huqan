'use strict';

/**
 * The protected loopback transport (ADR-018 §3/§4, #3999): real HTTP over
 * 127.0.0.1, real keys, a real durable nonce store, and the refusal order of
 * the specification -- and one round trip through the *real* MCP server so
 * the transport is proven against the production handler, not a stub alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createClientEnvelope, createClientKey } = require('../lib/mcp/client-envelope');
const { createDurableCapabilityNonceStore } = require('../lib/mcp-capability-nonce-store');
const { createLoopbackMcpService } = require('../lib/mcp/loopback-service');

const WORKSPACE_ID = '0123456789abcdef';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-loopback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(t, service) {
  return new Promise((resolve) => {
    service.listen(0, '127.0.0.1', () => resolve(service.address().port));
  });
}

function post(port, { envelope, client = 'agent-x', body = {}, rawBody, headers = {} } = {}) {
  const payload = rawBody ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    if (envelope) request.setHeader('x-huqan-mcp-envelope', Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url'));
    if (client !== null) request.setHeader('x-huqan-client', client);
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    request.end(payload);
  });
}

/** A service with one enrolled client and a stub handler, listening. */
async function startStubService(t, { handleRequest, now } = {}) {
  const dir = tempDir(t);
  const store = createDurableCapabilityNonceStore({ directory: path.join(dir, 'nonces') });
  const key = createClientKey();
  const enrolled = [{ client_id: 'agent-x', key_id: key.keyId, public_key: key.publicKeyBase64url }];
  const service = createLoopbackMcpService({
    server: { handleRequest: handleRequest || ((message) => ({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } })) },
    enrolled,
    nonceStore: store,
    workspaceId: WORKSPACE_ID,
    ...(now ? { now } : {}),
  });
  const port = await listen(t, service);
  t.after(() => service.close());
  return { port, key, enrolled, dir };
}

function signedCall(key, { op, args, now, nonce, client = 'agent-x', workspace = WORKSPACE_ID } = {}) {
  return createClientEnvelope({
    client_id: client, workspace_id: workspace, op: op ?? 'tools/list', args: args ?? {}, ...(now ? { now } : {}), ...(nonce ? { nonce } : {}),
  }, key.privateKey);
}

test('a signed request reaches the handler; the answer is the handler\u2019s own JSON-RPC', async (t) => {
  const { port, key } = await startStubService(t);
  const message = { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} };
  const envelope = signedCall(key, { op: message.method, args: message.params });
  const response = await post(port, { envelope, body: message });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { jsonrpc: '2.0', id: 7, result: { echoed: 'tools/list' } });
});

test('every refusal is a 403 with the step code and no echo of the request', async (t) => {
  const { port, key } = await startStubService(t);
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { filter: 'secret-value' } };

  const noEnvelope = await post(port, { body: message });
  assert.equal(noEnvelope.status, 403);
  assert.deepEqual(JSON.parse(noEnvelope.text).error.code, 'malformed');
  assert.doesNotMatch(noEnvelope.text, /secret-value/);

  const wrongClient = await post(port, { envelope: signedCall(key, { op: 'tools/list', args: message.params }), client: 'agent-other', body: message });
  assert.equal(wrongClient.status, 403);
  assert.equal(JSON.parse(wrongClient.text).error.code, 'binding_mismatch');

  const wrongWorkspace = await post(port, {
    envelope: signedCall(key, { op: 'tools/list', args: message.params, workspace: 'ffffffffffffffff' }), body: message,
  });
  assert.equal(JSON.parse(wrongWorkspace.text).error.code, 'binding_mismatch');

  const wrongOp = await post(port, {
    envelope: signedCall(key, { op: 'tools/call', args: message.params }), body: message,
  });
  assert.equal(JSON.parse(wrongOp.text).error.code, 'binding_mismatch');

  const wrongArgs = await post(port, {
    envelope: signedCall(key, { op: 'tools/list', args: { filter: 'different' } }), body: message,
  });
  assert.equal(JSON.parse(wrongArgs.text).error.code, 'args_mismatch');
});

test('an expired envelope is refused and its nonce stays unconsumed for the next attempt', async (t) => {
  const { port, key } = await startStubService(t);
  const message = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const stale = signedCall(key, { op: 'tools/list', args: {}, now: new Date(Date.now() - 61_000) });
  const response = await post(port, { envelope: stale, body: message });
  assert.equal(JSON.parse(response.text).error.code, 'expired');
  // A fresh envelope signed with the SAME nonce must still be accepted: the
  // refused envelope never consumed anything.
  const fresh = signedCall(key, { op: 'tools/list', args: {}, now: new Date(), nonce: stale.nonce });
  const second = await post(port, { envelope: fresh, body: message });
  assert.equal(second.status, 200);
});

test('a replayed envelope is refused by the durable store', async (t) => {
  const { port, key } = await startStubService(t);
  const message = { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} };
  const envelope = signedCall(key, { op: 'tools/list', args: {} });
  assert.equal((await post(port, { envelope, body: message })).status, 200);
  const replay = await post(port, { envelope, body: message });
  assert.equal(replay.status, 403);
  assert.equal(JSON.parse(replay.text).error.code, 'replayed');
});

test('transport-level refusals: wrong method, missing client header, oversized and unparseable bodies', async (t) => {
  const { port, key } = await startStubService(t);
  const envelope = signedCall(key, { op: 'tools/list', args: {} });

  const get = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
      let text = '';
      response.on('data', (c) => { text += c; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    }).on('error', reject);
  });
  assert.equal(get.status, 405);
  assert.equal(JSON.parse(get.text).error.code, 'method_not_allowed');

  const noClient = await post(port, { envelope, client: null, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(JSON.parse(noClient.text).error.code, 'binding_mismatch');

  const oversized = await post(port, { envelope, body: { pad: 'x'.repeat(70 * 1024) } });
  assert.equal(oversized.status, 413);

  const unparseable = await post(port, { envelope, rawBody: '{nope', body: null });
  assert.equal(unparseable.status, 400);
  assert.equal(JSON.parse(unparseable.text).error.code, 'invalid_request');
});

test('a throwing or rejecting handler answers a bounded internal error, not a crash', async (t) => {
  const { port, key } = await startStubService(t, {
    handleRequest: (message) => {
      if (message.id === 1) throw new Error('boom with secrets');
      if (message.id === 2) return Promise.reject(new Error('async boom'));
      return { jsonrpc: '2.0', id: message.id, result: {} };
    },
  });
  const envelopeFor = (id) => signedCall(key, { op: 'tools/list', args: {} });
  const sync = await post(port, { envelope: envelopeFor(1), body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(sync.status, 200);
  const syncBody = JSON.parse(sync.text);
  assert.equal(syncBody.error.code, -32603);
  assert.doesNotMatch(syncBody.error.message, /secrets/);
  const async = await post(port, { envelope: signedCall(key, { op: 'tools/list', args: {} }), body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  assert.equal(JSON.parse(async.text).error.code, -32603);
});

test('a cancelled call that settles to null answers 204 with no body', async (t) => {
  const { port, key } = await startStubService(t, { handleRequest: () => Promise.resolve(null) });
  const response = await post(port, {
    envelope: signedCall(key, { op: 'tools/call', args: {} }),
    body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} },
  });
  assert.equal(response.status, 204);
  assert.equal(response.text, '');
});

test('the real MCP server answers a signed tools/list through the loopback transport', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-loopback-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const Kernel = require('../kernel');
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(root, 'memory.json') });
  const { createServer } = require('../mcpServer');
  const server = createServer({ kernel, approvalStore: null });
  t.after(() => server.close?.());

  const dir = tempDir(t);
  const store = createDurableCapabilityNonceStore({ directory: path.join(dir, 'nonces') });
  const key = createClientKey();
  const service = createLoopbackMcpService({
    server,
    enrolled: [{ client_id: 'agent-x', key_id: key.keyId, public_key: key.publicKeyBase64url }],
    nonceStore: store,
    workspaceId: WORKSPACE_ID,
  });
  const port = await listen(t, service);
  t.after(() => service.close());

  const message = { jsonrpc: '2.0', id: 'tools-1', method: 'tools/list', params: {} };
  const envelope = signedCall(key, { op: message.method, args: message.params });
  const response = await post(port, { envelope, body: message });
  assert.equal(response.status, 200);
  const parsed = JSON.parse(response.text);
  assert.equal(parsed.jsonrpc, '2.0');
  assert.ok(Array.isArray(parsed.result.tools) && parsed.result.tools.length > 0, 'the real handler answered through the envelope');
  // And an unsigned call to the same real server is refused before the gate.
  const refused = await post(port, { body: message });
  assert.equal(refused.status, 403);
});

test('the service constructor refuses to run without the pieces it needs', () => {
  const store = createDurableCapabilityNonceStore({ directory: path.join(os.tmpdir(), `huqan-loopback-args-${process.pid}`) });
  const server = { handleRequest: () => ({}) };
  assert.throws(() => createLoopbackMcpService({}), /server/);
  assert.throws(() => createLoopbackMcpService({ server }), /enrolled/);
  assert.throws(() => createLoopbackMcpService({ server, enrolled: [] }), /nonce store/);
  assert.throws(() => createLoopbackMcpService({ server, enrolled: [], nonceStore: store }), /workspace id/);
  assert.throws(() => createLoopbackMcpService({ server, enrolled: [], nonceStore: store, workspaceId: 'nope' }), /workspace id/);
});
