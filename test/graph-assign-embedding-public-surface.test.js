'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const Kernel = require('../kernel');
const Dream = require('../dream');

// #2154: dream.js wrote each computed vector through Graph's private
// `_assignEmbedding`. The member is promoted under its own name -- a bare
// rename, body unchanged, no alias -- the same shape as #2438 and #2415.
// Graph never calls it internally, so replacing the private name on an
// instance only catches outside callers.

const ROOT = path.join(__dirname, '..');

function withDream(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2154-'));
  const kernel = new Kernel({ noLoad: true, loadPlugins: false, useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  try {
    run(kernel, new Dream(kernel));
  } finally {
    kernel.graph?.close?.();
    kernel.memory?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Graph.assignEmbedding is the public embedding-write surface (#2154)', () => {
  it('assignEmbedding is public and the private name is gone', () => {
    assert.equal(typeof Graph.prototype.assignEmbedding, 'function', 'assignEmbedding must be public');
    assert.equal(Graph.prototype._assignEmbedding, undefined, '_assignEmbedding must be gone');
  });

  it('Dream#embedding writes every vector through the public surface', () => {
    withDream((kernel, dream) => {
      kernel.graph.addNode('kedi', 'kedi');
      kernel.graph.addNode('hayvan', 'hayvan');
      kernel.graph._assignEmbedding = () => { throw new Error('private Graph#_assignEmbedding used'); };

      const result = dream.embedding({ dimensions: 4, walksPerNode: 1, walkLength: 1 });

      const keys = Object.keys(kernel.graph._nodes);
      assert.deepEqual(result, { dimensions: 4, nodes: keys.length });
      for (const key of keys) {
        const { embedding } = kernel.graph._nodes[key];
        assert.ok(embedding instanceof Float64Array, `${key} has no embedding`);
        assert.equal(embedding.length, 4);
      }
    });
  });

  it('dream.js names no private _assignEmbedding', () => {
    const source = fs.readFileSync(path.join(ROOT, 'dream.js'), 'utf8');
    assert.doesNotMatch(source, /\._assignEmbedding\b/);
  });
});
