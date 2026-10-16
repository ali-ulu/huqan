'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { loadEmbeddingsLenient } = require('../lib/graph-json-persistence');
const { writeCurrentState } = require('../lib/graph-json-snapshot');
const { commitJsonTransaction } = require('../lib/graph-json-transaction');
const { readGraphSurfaceSource } = require('./helpers/graph-surface-source');

const ROOT = path.join(__dirname, '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedEmbedding(graph, key, vector) {
  graph._nodes[key].embedding = new Float64Array(vector);
  return key;
}

describe('Graph.restoreEmbeddings is the public embedding-restore surface (#2349)', () => {
  it('the JSON load path reaches the graph through the public restoreEmbeddings', () => {
    const dir = tmpDir('huqan-restore-load-');
    const sidecar = path.join(dir, 'memory.embeddings.json');
    fs.writeFileSync(sidecar, JSON.stringify({ 'default::a': [1, 2, 3] }));

    // A graph that offers only the documented public surface: no
    // _restoreEmbeddings, because that name is no longer part of the contract.
    let restored = null;
    const graph = {
      _embeddingPath: sidecar,
      restoreEmbeddings(vectors) { restored = vectors; },
    };

    loadEmbeddingsLenient(graph);

    assert.deepEqual(restored, { 'default::a': [1, 2, 3] },
      'the loader must restore through the public restoreEmbeddings surface');
    assert.equal(graph._embeddingsIgnored, false,
      'a successful restore must not be recorded as an ignored embedding load');
    assert.equal(graph._embeddingLoadError, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the snapshot save path restores embeddings through the public surface in its finally', () => {
    const stripped = { 'default::a': [4, 5, 6] };
    let restored = null;
    const graph = {
      stripEmbeddings: () => stripped,
      writeStrippedState: () => { throw new Error('disk failure after stripping'); },
      restoreEmbeddings(vectors) { restored = vectors; },
    };

    assert.throws(() => writeCurrentState(graph), /disk failure after stripping/,
      'the original write failure must survive the finally block');
    assert.deepEqual(restored, stripped,
      'a failed save must still restore the stripped vectors through the public surface');
  });

  it('the transaction commit path restores embeddings without touching the private name', () => {
    const dir = tmpDir('huqan-restore-txn-');
    const memoryPath = path.join(dir, 'memory.json');
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.addNode('a', 'A');
    const key = seedEmbedding(graph, Object.keys(graph._nodes)[0], [7, 8, 9]);

    // Make any reach into the private call surface loud instead of silent.
    graph._restoreEmbeddings = () => { throw new Error('private _restoreEmbeddings surface used'); };

    commitJsonTransaction(graph, 'op-1', { reason: 'test' });

    assert.deepEqual(Array.from(graph._nodes[key].embedding), [7, 8, 9],
      'the commit finally must restore the stripped live vectors');
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the strip/write/restore round trip is unchanged', () => {
    const dir = tmpDir('huqan-restore-roundtrip-');
    const memoryPath = path.join(dir, 'memory.json');
    const graph = new Graph({ memoryPath, useSQLite: false });

    assert.equal(typeof graph.restoreEmbeddings, 'function', 'restoreEmbeddings must be public');
    assert.equal(typeof graph._restoreEmbeddings, 'undefined', 'the private name must be gone');

    graph.addNode('a', 'A');
    graph.addNode('b', 'B');
    const keys = Object.keys(graph._nodes);
    seedEmbedding(graph, keys[0], [1, 2, 3]);
    seedEmbedding(graph, keys[1], [4, 5]);

    graph.save();
    // save() strips embeddings off the live records; the finally must put them back.
    assert.ok(graph._nodes[keys[0]].embedding instanceof Float64Array,
      'save() must not leave the live record without its restored vector');
    assert.deepEqual(Array.from(graph._nodes[keys[0]].embedding), [1, 2, 3]);
    graph.close();

    const reloaded = new Graph({ memoryPath, useSQLite: false });
    reloaded.load();
    assert.deepEqual(Array.from(reloaded._nodes[keys[0]].embedding), [1, 2, 3]);
    assert.deepEqual(Array.from(reloaded._nodes[keys[1]].embedding), [4, 5]);
    reloaded.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no caller or definition reaches for the private _restoreEmbeddings name', () => {
    for (const name of ['graph-json-persistence.js', 'graph-json-snapshot.js', 'graph-json-transaction.js']) {
      const source = fs.readFileSync(path.join(ROOT, 'lib', name), 'utf8');
      assert.doesNotMatch(source, /_restoreEmbeddings/, `${name} must not touch the private surface`);
    }
    const graphSource = readGraphSurfaceSource();
    assert.doesNotMatch(graphSource, /_restoreEmbeddings/,
      'graph.js must neither define nor call the private name');
  });
});
