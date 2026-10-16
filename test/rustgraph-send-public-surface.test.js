'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RustGraph = require('../rustGraph');
const { runRustSandbox } = require('../lib/reason-sandbox');

const ROOT = path.join(__dirname, '..');

// A RustGraph stand-in that answers only through the public `send`. Reaching
// for the private `_send` throws instead of silently resolving to undefined.
function publicSendGraph(reply) {
  const sent = [];
  return {
    sent,
    graph: {
      async send(cmd) { sent.push(cmd); return reply(cmd); },
      _send() { throw new Error('private RustGraph#_send used'); },
      destroy() {},
    },
  };
}

describe('RustGraph.send is the public IPC surface (#2350)', () => {
  it('send is public and the private _send name is gone', () => {
    assert.equal(typeof RustGraph.prototype.send, 'function', 'send must be public');
    assert.equal(RustGraph.prototype._send, undefined, '_send must be gone');
  });

  it('start is public and the private _start name is gone (#2963)', () => {
    assert.equal(typeof RustGraph.prototype.start, 'function', 'start must be public');
    assert.equal(RustGraph.prototype._start, undefined, '_start must be gone');
  });

  it('the reason sandbox learns and asks through the public send', async () => {
    const { sent, graph } = publicSendGraph((cmd) => (
      cmd.commands[0].cmd === 'learn'
        ? { ok: true, results: [] }
        : { ok: true, results: cmd.commands.map(c => ({ answer: `ans:${c.question}` })) }
    ));

    const answers = await runRustSandbox({ learn: ['kedi hayvandır'], ask: ['kedi ne?'], createRustGraph: () => graph });

    assert.deepEqual(answers, ['ans:kedi ne?']);
    assert.deepEqual(sent.map(cmd => cmd.commands.map(c => c.cmd)), [['learn'], ['ask']]);
  });

  it('a graph without the public send is treated as no Rust backend', async () => {
    const answers = await runRustSandbox({ ask: ['x'], createRustGraph: () => ({ _send: async () => ({ ok: true, results: [] }) }) });
    assert.equal(answers, null);
  });

  it('the sandbox source names no private _send', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'reason-sandbox.js'), 'utf8');
    assert.doesNotMatch(source, /\b_send\b/, 'lib/reason-sandbox.js must not name RustGraph#_send');
  });
});
