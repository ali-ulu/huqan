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

const crypto = require('node:crypto');

const Graph = require('../graph');
const { revision, snapshotHashes } = require('../lib/graph-json-snapshot');
const { commitJsonTransaction, redoPathFor } = require('../lib/graph-json-transaction');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const emptyJournal = () => ({ operations: {}, receipts: {}, receiptsById: {}, chainTips: {}, seals: {} });

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

test('the snapshot hashes are the hashes of the files on disk', () => {
  const { graph, memoryPath } = makeGraph('snapshot-hashes');
  graph.runMutationOnce('op-snapshot-hashes', () => {
    graph.addNode('kus', 'Kus');
    return { ok: true };
  });

  assert.deepEqual(snapshotHashes(graph), {
    memory: sha256(fs.readFileSync(memoryPath)),
    embeddings: sha256(fs.readFileSync(graph._embeddingPath)),
  });
});

test('a supplied before-image hash cannot skip the disk check', () => {
  const { graph } = makeGraph('supplied-hash-mismatch');
  graph.runMutationOnce('op-supplied-hash', () => {
    graph.addNode('balik', 'Balik');
    return { ok: true };
  });
  const redoPath = redoPathFor(graph.jsonJournalPath());
  // A different after-image, so publish() has something to write and cannot
  // return early on "already published".
  graph.addNode('yeni', 'Yeni');

  // A caller that hands over a hash the disk does not have must not be able to
  // overwrite the file: publish() re-reads and refuses. The supplied hash only
  // saves a read, it never replaces the check (#4636).
  assert.throws(
    () => commitJsonTransaction(graph, 'op-stale-hash', emptyJournal(), null,
      { memory: 'f'.repeat(64), embeddings: 'f'.repeat(64) }),
    error => error.code === 'GRAPH_JSON_RECOVERY_CONFLICT',
  );
  // The refused commit leaves its redo record behind; drop it so the recovery
  // path of the next case starts from a clean store.
  fs.rmSync(redoPath, { force: true });
});

test('the redo record keeps the real before-images when hashes are supplied', () => {
  const { graph, memoryPath } = makeGraph('supplied-hash-match');
  graph.runMutationOnce('op-real-before', () => {
    graph.addNode('at', 'At');
    return { ok: true };
  });
  const before = snapshotHashes(graph);
  const redoPath = redoPathFor(graph.jsonJournalPath());

  assert.throws(
    () => commitJsonTransaction(graph, 'op-real-before-next', emptyJournal(), point => {
      if (point === 'after-prepared') throw new Error('stop-before-publish');
    }, before),
    /stop-before-publish/u,
  );
  const record = JSON.parse(fs.readFileSync(redoPath, 'utf8'));
  assert.equal(record.files.memory.beforeHash, sha256(fs.readFileSync(memoryPath)));
  assert.equal(record.files.embeddings.beforeHash, sha256(fs.readFileSync(graph._embeddingPath)));
  fs.rmSync(redoPath, { force: true });
});
