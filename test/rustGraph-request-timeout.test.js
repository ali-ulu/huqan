const test = require('node:test');
const assert = require('node:assert/strict');
const RustGraph = require('../rustGraph');

// Simulates a Rust process that never replies, without needing the actual
// axiom-core binary: a fake `_proc` whose stdin.write() is a no-op means
// `_onData` is never invoked and `_pending` would stay unresolved forever
// without the request timeout (#373).
function makeHangingRustGraph(requestTimeoutMs) {
  const rg = new RustGraph({ memoryPath: 'unused.json', requestTimeoutMs });
  rg._start = function () {
    if (this._proc) return;
    this._proc = {
      ref() {},
      unref() {},
      stdin: { ref() {}, unref() {}, write() {}, end() {}, on() {} },
      stdout: { ref() {}, unref() {} },
    };
    this._ready = true;
  };
  return rg;
}

test('rustGraph _send resolves with request_timeout instead of hanging forever (#373)', async () => {
  // The production timer is intentionally unref()'d so an idle bridge never
  // keeps a host process alive; keep this test process alive ourselves so
  // the assertion has time to run instead of racing process exit.
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const rg = makeHangingRustGraph(20);
    const res = await rg._send({ cmd: 'add_node', id: 'x' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'request_timeout');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('rustGraph clears the timer once a real reply arrives (no leaked resolve)', async () => {
  const rg = makeHangingRustGraph(500);
  rg._start();
  const pending = rg._send({ cmd: 'add_node', id: 'y' });
  const [reqId] = rg._pending.keys();
  rg._onData(Buffer.from(JSON.stringify({ _reqId: reqId, ok: true }) + '\n'));
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(rg._pending.size, 0);
});

test('rustGraph _send does not crash when the process is gone before write (#373)', async () => {
  const rg = new RustGraph({ memoryPath: 'unused.json' });
  rg._start = function () {
    this._proc = null;
    this._fallback = null;
    this._ready = true;
  };
  const res = await rg._send({ cmd: 'add_node', id: 'z' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'process_unavailable');
});
