'use strict';

/**
 * The JSON commit records the snapshot revision from the bytes it published
 * instead of reading and re-hashing both files again. These two cases pin the
 * halves of that claim: the recorded revision must be the revision on disk, and
 * skipping the re-read must not weaken external-write detection.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Graph = require('../graph');
const { revision } = require('../lib/graph-json-snapshot');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-json-commit-revision-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

let seq = 0;
function makeGraph(name) {
  seq += 1;
  const memoryPath = path.join(root, `${name}-${seq}.json`);
  return {
    graph: new Graph({ memoryPath, useSQLite: false, noLoad: true }),
    memoryPath,
  };
}

function diskRevision(graph) {
  return revision(fs.readFileSync(graph.memoryPath), fs.readFileSync(graph._embeddingPath));
}

test('the revision a commit records is the revision on disk', () => {
  const { graph } = makeGraph('recorded-revision');
  graph.runMutationOnce('op-recorded-revision', () => {
    graph.addNode('kedi', 'Kedi');
    return { ok: true };
  });

  assert.equal(graph._jsonSnapshotRevision, diskRevision(graph));
});

test('an external write after a commit is still detected as a conflict', () => {
  const { graph, memoryPath } = makeGraph('external-write');
  graph.runMutationOnce('op-external-write', () => {
    graph.addNode('kopek', 'Kopek');
    return { ok: true };
  });

  const tampered = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  tampered.nodes.extra = { id: 'extra', label: 'Extra', workspaceId: 'default' };
  fs.writeFileSync(memoryPath, JSON.stringify(tampered));

  assert.throws(() => graph.save(), error => error.code === 'GRAPH_JSON_WRITE_CONFLICT');
});
