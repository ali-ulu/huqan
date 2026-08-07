const test = require('node:test');
const assert = require('node:assert/strict');
const RustGraph = require('../rustGraph');

function makeFakeRustGraph() {
  const rg = new RustGraph({ memoryPath: 'unused.json', requestTimeoutMs: 500 });
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

test('rustGraph _onData resets and rejects pending requests instead of growing the buffer without bound (#372)', async () => {
  const rg = makeFakeRustGraph();
  rg._start();

  const pending = rg._send({ cmd: 'add_node', id: 'x' });

  // Simulate a malicious/buggy Rust process streaming a huge, newline-less
  // chunk. Without a size cap this._buf would grow without bound (OOM DoS).
  const hugeChunk = Buffer.alloc(11 * 1024 * 1024, 'a');
  rg._onData(hugeChunk);

  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(res.error, 'buffer_overflow');
  assert.equal(rg._buf, '');
  assert.equal(rg._pending.size, 0);
});

test('rustGraph _onData keeps working normally after a buffer-overflow reset', async () => {
  const rg = makeFakeRustGraph();
  rg._start();

  rg._onData(Buffer.alloc(11 * 1024 * 1024, 'a'));

  const pending = rg._send({ cmd: 'add_node', id: 'y' });
  const [reqId] = rg._pending.keys();
  rg._onData(Buffer.from(JSON.stringify({ _reqId: reqId, ok: true }) + '\n'));
  const res = await pending;
  assert.equal(res.ok, true);
});
