'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { getEmbeddingLoadFailures } = require('../lib/graph-json-persistence');

describe('corrupt embeddings are counted, not silent or fatal (#1984)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-embed-corrupt-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('JSON path: corrupt sidecar loads graph, sets embeddingsIgnored', () => {
    const memoryPath = path.join(root, 'json.json');
    const seed = new Graph({ memoryPath, useSQLite: false });
    seed.addNode('a');
    seed.save();
    seed.close();
    const before = getEmbeddingLoadFailures();
    fs.writeFileSync(seed._embeddingPath, '{corrupt');
    const reloaded = new Graph({ memoryPath, useSQLite: false });
    reloaded.load();
    assert.equal(reloaded.getNode('a').id, 'a');
    assert.equal(reloaded._embeddingsIgnored, true);
    assert.ok(reloaded._embeddingLoadError);
    assert.ok(getEmbeddingLoadFailures() > before);
    reloaded.addNode('b');
    assert.doesNotThrow(() => reloaded.save());
    reloaded.close();
    const persisted = new Graph({ memoryPath, useSQLite: false });
    persisted.load();
    assert.equal(persisted.getNode('a').id, 'a');
    assert.equal(persisted.getNode('b').id, 'b');
    assert.equal(persisted._embeddingsIgnored, false);
    persisted.close();
  });

  it('still rejects a sidecar changed by another writer after corrupt-sidecar load (#2033)', () => {
    const memoryPath = path.join(root, 'concurrent.json');
    const seed = new Graph({ memoryPath, useSQLite: false });
    seed.addNode('a');
    seed.save();
    seed.close();
    fs.writeFileSync(seed._embeddingPath, '{corrupt');
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.load();
    // Invalid UTF-8 must also retain its exact bytes in the next snapshot.
    const external = Buffer.from([0xff, 0xfe, 0x7b]);
    fs.writeFileSync(graph._embeddingPath, external);
    assert.throws(() => graph.save(), { code: 'GRAPH_JSON_WRITE_CONFLICT' });
    assert.deepEqual(fs.readFileSync(graph._embeddingPath), external);
    graph.load();
    assert.doesNotThrow(() => graph.save());
    graph.close();
  });
});
