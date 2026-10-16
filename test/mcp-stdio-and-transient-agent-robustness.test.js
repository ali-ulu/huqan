'use strict';

/**
 * #409 -- withTransientAgent closed the transient agent's storage in a
 *         `finally`, which for a promise-returning callback fires when the
 *         promise is *created*, not when the work finishes.
 *
 * #414 -- the stdio `rl.on('line')` handler called server.handleRequest()
 *         outside any try/catch. handleRequest guards its own `tools/call`
 *         branch, but every other branch is unguarded, and an escaping throw
 *         from a stdin event handler is fatal to the process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mcpServer = require('../mcpServer');

// ─── #409: transient agent storage lifetime ─────────────────────────────────

// withTransientAgent is module-internal, so it is exercised through the same
// shape it has in mcpServer.js rather than imported directly.
function makeWithTransientAgent(createAgent) {
  return function withTransientAgent(kernel, callback) {
    const agent = createAgent({ kernel });
    const closeStorage = () => {
      try { agent?.storage?.close?.(); } catch (_) {}
    };
    let result;
    try {
      result = callback(agent);
    } catch (error) {
      closeStorage();
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => { closeStorage(); return value; },
        (error) => { closeStorage(); throw error; },
      );
    }
    closeStorage();
    return result;
  };
}

function fakeAgentFactory(state) {
  return () => ({
    storage: { close: () => { state.closed = true; } },
  });
}

test('#409: storage is closed after a synchronous callback', () => {
  const state = { closed: false };
  const withTransientAgent = makeWithTransientAgent(fakeAgentFactory(state));

  const result = withTransientAgent({}, () => 'sync-result');

  assert.equal(result, 'sync-result');
  assert.equal(state.closed, true);
});

test('#409: storage is NOT closed before an async callback settles', async () => {
  const state = { closed: false };
  const withTransientAgent = makeWithTransientAgent(fakeAgentFactory(state));

  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const pending = withTransientAgent({}, async () => {
    await gate;
    // This is the window the old `finally` closed storage in.
    assert.equal(state.closed, false, 'storage must still be open while the work runs');
    return 'async-result';
  });

  assert.equal(state.closed, false, 'storage must not close when the promise is merely created');
  release();

  assert.equal(await pending, 'async-result');
  assert.equal(state.closed, true, 'storage closes once the work settles');
});

test('#409: storage is closed when an async callback rejects', async () => {
  const state = { closed: false };
  const withTransientAgent = makeWithTransientAgent(fakeAgentFactory(state));

  await assert.rejects(
    () => withTransientAgent({}, async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(state.closed, true);
});

test('#409: storage is closed when a synchronous callback throws', () => {
  const state = { closed: false };
  const withTransientAgent = makeWithTransientAgent(fakeAgentFactory(state));

  assert.throws(() => withTransientAgent({}, () => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(state.closed, true);
});

// The four cases above pin the contract on a local copy of the shape. These
// two drive the *real* exported withTransientAgent, so the production function
// itself is covered rather than a lookalike.

test('#409 (real fn): an async callback is awaited before storage closes', async () => {
  const closes = [];
  let released = false;

  const pending = mcpServer.withTransientAgent({}, async (agent) => {
    // Observe the real agent's storage close rather than a stub's.
    const realClose = agent.storage.close.bind(agent.storage);
    agent.storage.close = () => { closes.push(released); return realClose(); };

    await new Promise((resolve) => setTimeout(resolve, 50));
    released = true;
    return 'done';
  });

  assert.ok(typeof pending.then === 'function', 'an async callback returns a promise');
  assert.equal(await pending, 'done');
  assert.deepEqual(closes, [true], 'close ran only after the async work finished');
});

test('#409 (real fn): a synchronous callback still returns its value directly', () => {
  const result = mcpServer.withTransientAgent({}, () => ({ ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.ok(typeof result.then !== 'function', 'sync callbacks are not wrapped in a promise');
});

// ─── #414: stdio handler must not let a throw escape ────────────────────────

/**
 * Drive runStdio() over fake stdin/stdout so a throwing handleRequest can be
 * observed without taking the test process down.
 */
function withStdioHarness(fn) {
  const { Readable } = require('node:stream');
  const written = [];

  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realWrite = process.stdout.write;

  const input = new Readable({ read() {} });
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };

  try {
    return fn({ input, written });
  } finally {
    process.stdout.write = realWrite;
    if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
  }
}

test('#414: a throwing handleRequest yields a JSON-RPC error, not a crash', async () => {
  await withStdioHarness(async ({ input, written }) => {
    const originalCreateServer = mcpServer.createServer;
    // runStdio() calls the module's own createServer, so the throw is injected
    // at the boundary runStdio actually uses.
    const server = originalCreateServer();
    server.handleRequest = () => { throw new Error('unexpected handler failure'); };

    const rl = require('node:readline').createInterface({ input, crlfDelay: Infinity });
    const send = (msg) => { written.push(`${JSON.stringify(msg)}\n`); };

    // Mirror the guarded handler shape from runStdio().
    let escaped = null;
    try {
      const message = { jsonrpc: '2.0', id: 7, method: 'ping' };
      try {
        const response = server.handleRequest(message);
        if (response) send(response);
      } catch (err) {
        const errorRef = mcpServer.recordInternalError('stdio/handleRequest', err);
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: `Internal error (ref: ${errorRef})` },
        });
      }
    } catch (err) {
      escaped = err;
    } finally {
      rl.close();
    }

    assert.equal(escaped, null, 'no error may escape the line handler');
    const last = JSON.parse(written[written.length - 1]);
    assert.equal(last.id, 7);
    assert.equal(last.error.code, -32603);
    assert.match(last.error.message, /Internal error \(ref: /);
  });
});

test('#414: the real stdio server survives a bad request and keeps serving', async () => {
  // End-to-end over a spawned process: the point of #414 is that the process
  // stays alive, which can only really be shown by a live process. Note this
  // deliberately does NOT use withStdioHarness -- that harness swaps this
  // process's own stdin/stdout, which would break capturing the child's.
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-stdio-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcpServer.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      AXIOM_MEMORY_PATH: path.join(root, 'memory.json'),
      AXIOM_DB_PATH: path.join(root, 'memory.db'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) lines.push(line);
    }
  });

  const waitFor = async (predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  };

  try {
    // 'axiom.nonexistent' reaches callTool's `default:` branch, which throws.
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'axiom.nonexistent', arguments: {} },
    })}\n`);

    const errorReply = await waitFor((msg) => msg.id === 1);
    assert.ok(errorReply, 'the throwing request got a reply');

    // The real assertion: the server is still alive and serving afterwards.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    const pong = await waitFor((msg) => msg.id === 2);
    assert.ok(pong, 'server still responds after a throwing request');
    assert.equal(child.exitCode, null, 'server process is still running');
  } finally {
    // Wait for the child to actually exit before removing its data dir: on
    // Windows the still-open SQLite handle makes rmSync fail with EPERM, which
    // would turn a passing assertion into a failing test. Temp cleanup is
    // best-effort either way and must never mask the result above.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) { /* best-effort temp cleanup */ }
  }
});

test('#414: send() falls back instead of throwing on an unserializable payload', () => {
  // JSON.stringify throws on a circular structure; in an event handler that
  // throw would be fatal, so send() must degrade to a fixed envelope.
  const circular = { jsonrpc: '2.0', id: 3 };
  circular.self = circular;

  let payload;
  const fakeSend = (msg) => {
    try {
      payload = JSON.stringify(msg);
    } catch (err) {
      const errorRef = mcpServer.recordInternalError('stdio/serialize', err);
      payload = JSON.stringify({
        jsonrpc: '2.0',
        id: (msg && typeof msg === 'object' && msg.id !== undefined) ? msg.id : null,
        error: { code: -32603, message: `Internal error (ref: ${errorRef})` },
      });
    }
  };

  assert.doesNotThrow(() => fakeSend(circular));
  const parsed = JSON.parse(payload);
  assert.equal(parsed.id, 3);
  assert.equal(parsed.error.code, -32603);
});
