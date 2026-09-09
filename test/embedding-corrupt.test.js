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
    reloaded.close();
  });
});
