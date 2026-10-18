'use strict';

/**
 * The per-session stdio proxy (ADR-018 §3, #3999): argument and key-file
 * validation in-process, one full run of the real proxy over real loopback
 * with a real loopback service behind it, and the bounded-unreachable path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createClientKey } = require('../lib/mcp/client-envelope');
const { createDurableCapabilityNonceStore } = require('../lib/mcp-capability-nonce-store');
const { createLoopbackMcpService } = require('../lib/mcp/loopback-service');
const proxy = require('../lib/mcp/stdio-proxy');

const WORKSPACE_ID = '0123456789abcdef';
const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'huqan-mcp.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-proxy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A real loopback service with one enrolled client, listening. */
async function startService(t, dir) {
  const store = createDurableCapabilityNonceStore({ directory: path.join(dir, 'nonces') });
  const key = createClientKey();
  const service = createLoopbackMcpService({
    server: { handleRequest: (message) => ({ jsonrpc: '2.0', id: message.id, result: { method: message.method } }) },
    enrolled: [{ client_id: 'agent-x', key_id: key.keyId, public_key: key.publicKeyBase64url }],
    nonceStore: store,
    workspaceId: WORKSPACE_ID,
  });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  return { port: service.address().port, key };
}

test('parseProxyArgs accepts a loopback endpoint and refuses anything else', () => {
  const args = proxy.parseProxyArgs('--url http://127.0.0.1:47921 --client agent-x --workspace 0123456789abcdef --key-file C:\\keys\\seed.txt');
  assert.equal(args.url.hostname, '127.0.0.1');
  assert.equal(args.client, 'agent-x');
  assert.equal(args.keyFile, 'C:\\keys\\seed.txt');
  assert.throws(() => proxy.parseProxyArgs('--url http://10.0.0.5:47921 --client a --workspace 0123456789abcdef --key-file k'),
    /non-loopback/);
  assert.throws(() => proxy.parseProxyArgs('--url http://127.0.0.1:47921 --client a --workspace short --key-file k'), /--workspace/);
  assert.throws(() => proxy.parseProxyArgs('--url http://127.0.0.1:47921'), /--client/);
});

test('the key file must hold exactly one seed line', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'seed.txt');
  fs.writeFileSync(file, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  const key = proxy.readSigningKey(file);
  assert.equal(key.asymmetricKeyType, 'ed25519');
  fs.writeFileSync(file, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n');
  assert.throws(() => proxy.readSigningKey(file), /exactly one/);
});

test('a spawned proxy carries frames to the protected server and refusals back', async (t) => {
  const dir = tempDir(t);
  const { spawn } = require('node:child_process');
  const { port, key } = await startService(t, dir);
  const seedFile = path.join(dir, 'seed.txt');
  fs.writeFileSync(seedFile, `${key.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url')}\n`);

  // Two frames, both signed for a workspace the service does not pin, so the
  // server refuses each at the binding step and the proxy relays both.
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'huqan.ask', arguments: { q: 1 } } },
  ].map((message) => `${JSON.stringify(message)}\n`).join('');

  // The seed file signs as agent-x, but the service pins one workspace; to
  // produce the binding refusal, point the proxy at another workspace id.
  // spawn (not spawnSync): the service answers from THIS process's event
  // loop, which a synchronous wait would block.
  const runChild = (workspace, frameText) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'proxy',
      '--url', `http://127.0.0.1:${port}`,
      '--client', 'agent-x',
      '--workspace', workspace,
      '--key-file', seedFile,
    ], { env: { ...process.env, NODE_OPTIONS: '' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`proxy timed out; stdout=${out} stderr=${err}`)); }, 20000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdin.write(frameText);
    child.stdin.end();
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
  });

  const refusedRun = await runChild('ffffffffffffffff', input);
  assert.equal(refusedRun.code, 0, refusedRun.err);
  const lines = refusedRun.out.trim().split('\n');
  assert.equal(lines.length, 2, lines.join(' | '));
  // Frames are relayed as independent requests: answers come back in
  // completion order, so pick them by id.
  const byId = new Map(lines.map((line) => { const parsed = JSON.parse(line); return [parsed.id, parsed]; }));
  for (const id of [1, 2]) {
    const refused = byId.get(id);
    assert.ok(refused, `an answer for id ${id}`);
    assert.equal(refused.error.code, proxy.PROXY_ERROR_ENVELOPE_REFUSED);
    assert.match(refused.error.message, /binding_mismatch/);
  }

  // And the correct workspace answers through the same proxy.
  const okRun = await runChild(WORKSPACE_ID, `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
  assert.equal(okRun.code, 0, okRun.err);
  const answered = JSON.parse(okRun.out.trim());
  assert.equal(answered.id, 1);
  assert.deepEqual(answered.result, { method: 'tools/list' });
});

test('the in-process proxy signs per frame and relays the answer; an unreachable service answers a bounded error', async (t) => {
  const dir = tempDir(t);
  const { port, key } = await startService(t, dir);
  const stdout = [];
  const fakeStdout = { write: (text) => stdout.push(text) };
  let dataHandler = null;
  const fakeStdin = { on: (event, handler) => { if (event === 'data') dataHandler = handler; } };
  const privateKey = key.privateKey;
  proxy.runProxy({
    url: `http://127.0.0.1:${port}`,
    client: 'agent-x',
    workspaceId: WORKSPACE_ID,
    privateKey,
    stdin: fakeStdin,
    stdout: fakeStdout,
  });
  assert.equal(typeof dataHandler, 'function', 'the proxy listens on stdin data');
  dataHandler(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} })}\n`));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(stdout.length, 1);
  const answered = JSON.parse(stdout[0]);
  assert.equal(answered.id, 11);
  assert.deepEqual(answered.result, { method: 'tools/list' });
  void dir;
});

test('an unreachable endpoint answers a bounded JSON-RPC error instead of crashing', async (t) => {
  const dir = tempDir(t);
  const key = createClientKey();
  const stdout = [];
  const fakeStdout = { write: (text) => stdout.push(text) };
  let dataHandler = null;
  const fakeStdin = { on: (event, handler) => { if (event === 'data') dataHandler = handler; } };
  proxy.runProxy({
    url: 'http://127.0.0.1:1', // port 1: nothing listens, connect fails fast
    client: 'agent-x',
    workspaceId: WORKSPACE_ID,
    privateKey: key.privateKey,
    stdin: fakeStdin,
    stdout: fakeStdout,
  });
  dataHandler(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} })}\n`));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(stdout.length, 1);
  const refused = JSON.parse(stdout[0]);
  assert.equal(refused.id, 12);
  assert.equal(refused.error.code, proxy.PROXY_ERROR_UNREACHABLE);
  void dir;
});

test('parseProxyArgs takes an argv element whole, spaces and all, and never a following option as a value', () => {
  const base = ['--url', 'http://127.0.0.1:47921', '--client', 'agent x', '--workspace', '0123456789abcdef'];
  const args = proxy.parseProxyArgs([...base, '--key-file', 'C:\\Users\\John Doe\\seed.txt']);
  assert.equal(args.keyFile, 'C:\\Users\\John Doe\\seed.txt');
  assert.equal(args.client, 'agent x');
  // An option name inside another option's value is not an option.
  const tricky = proxy.parseProxyArgs(['--url', 'http://127.0.0.1:47921', '--client', 'a --workspace b', '--workspace', '0123456789abcdef', '--key-file', 'k']);
  assert.equal(tricky.client, 'a --workspace b');
  assert.equal(tricky.workspaceId, '0123456789abcdef');
  assert.throws(() => proxy.parseProxyArgs([...base, '--key-file', '--client']), /--key-file/);
  assert.equal(proxy.parseProxyArgs('--url http://127.0.0.1:1 --client c --workspace 0123456789abcdef --key-file "C:\\k k\\s.txt"').keyFile, 'C:\\k k\\s.txt');
});

test('a frame the envelope cannot sign is answered with an error and the proxy keeps serving', async (t) => {
  const dir = tempDir(t);
  const { port, key } = await startService(t, dir);
  const stdout = [];
  let dataHandler = null;
  proxy.runProxy({
    url: `http://127.0.0.1:${port}`,
    client: 'agent-x',
    workspaceId: WORKSPACE_ID,
    privateKey: key.privateKey,
    stdin: { on: (event, handler) => { if (event === 'data') dataHandler = handler; } },
    stdout: { write: (text) => stdout.push(text) },
  });
  const frame = (message) => Buffer.from(`${JSON.stringify(message)}\n`);
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  t.after(() => process.off('unhandledRejection', record));
  dataHandler(frame({ jsonrpc: '2.0', id: 21, method: '', params: {} }));
  dataHandler(frame({ jsonrpc: '2.0', id: 22, method: 'x'.repeat(600), params: {} }));
  dataHandler(frame({ jsonrpc: '2.0', id: 23, method: 'tools/list', params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(unhandled, []);
  const byId = new Map(stdout.map((line) => { const parsed = JSON.parse(line); return [parsed.id, parsed]; }));
  assert.equal(byId.get(21).error.code, proxy.PROXY_ERROR_INVALID_REQUEST);
  assert.equal(byId.get(22).error.code, proxy.PROXY_ERROR_INVALID_REQUEST);
  assert.deepEqual(byId.get(23).result, { method: 'tools/list' });
});

test('a delayed answer with multibyte text is relayed intact', async (t) => {
  const dir = tempDir(t);
  const key = createClientKey();
  const store = createDurableCapabilityNonceStore({ directory: path.join(dir, 'nonces') });
  const service = createLoopbackMcpService({
    server: { handleRequest: (message) => new Promise((resolve) => setTimeout(() => resolve({ jsonrpc: '2.0', id: message.id, result: { slow: '\u00e9\u4e2d' } }), 300)) },
    enrolled: [{ client_id: 'agent-x', key_id: key.keyId, public_key: key.publicKeyBase64url }],
    nonceStore: store,
    workspaceId: WORKSPACE_ID,
  });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const stdout = [];
  let dataHandler = null;
  proxy.runProxy({
    url: `http://127.0.0.1:${service.address().port}`,
    client: 'agent-x',
    workspaceId: WORKSPACE_ID,
    privateKey: key.privateKey,
    stdin: { on: (event, handler) => { if (event === 'data') dataHandler = handler; } },
    stdout: { write: (text) => stdout.push(text) },
  });
  dataHandler(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: {} })}\n`));
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]).result, { slow: '\u00e9\u4e2d' });
});
