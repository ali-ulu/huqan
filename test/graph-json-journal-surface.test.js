'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { writeCurrentState, saveSnapshot } = require('../lib/graph-json-snapshot');
const { commitJsonTransaction, recoverJsonTransaction, redoPathFor } = require('../lib/graph-json-transaction');
const { readGraphSurfaceSource } = require('./helpers/graph-surface-source');

const ROOT = path.join(__dirname, '..');
const COLLABORATORS = ['graph-json-snapshot.js', 'graph-json-transaction.js'];
const PRIVATE_SURFACE = ['_jsonJournalPath', '_stripEmbeddings', '_writeStrippedState', '_jsonTransactionFault'];

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A Graph offering only the documented public journal surface: the three
 * promoted members plus the already-public restoreEmbeddings. The private
 * names are deliberately absent, so a reach for one is a TypeError here
 * rather than a silent pass.
 *
 * The four live-containers (memoryPath/_embeddingPath/_nodes/...) are the data
 * the persistence code serializes, not part of the surface under test.
 */
function publicSurfaceGraph(dir) {
  const paths = {
    memoryPath: path.join(dir, 'memory.json'),
    embeddingPath: path.join(dir, 'memory.embeddings.json'),
    journalPath: path.join(dir, 'memory.mutations.json'),
  };
  const log = [];
  const graph = {
    memoryPath: paths.memoryPath,
    _embeddingPath: paths.embeddingPath,
    _db: null,
    _nodes: { a: { id: 'a', workspaceId: 'default', embedding: new Float64Array([7, 8, 9]) } },
    _edges: {},
    _candidateClaims: [],
    _auditEvents: [],
    jsonJournalPath: () => { log.push('journalPath'); return paths.journalPath; },
    stripEmbeddings() {
      log.push('strip');
      const embeddings = {};
      for (const [id, node] of Object.entries(graph._nodes)) {
        if (node.embedding) { embeddings[id] = Array.from(node.embedding); delete node.embedding; }
      }
      return embeddings;
    },
    writeStrippedState(embeddings) { log.push(['write', embeddings]); },
    restoreEmbeddings(embeddings) {
      log.push('restore');
      for (const [id, vector] of Object.entries(embeddings)) {
        if (graph._nodes[id]) graph._nodes[id].embedding = new Float64Array(vector);
      }
    },
  };
  return { graph, log, paths };
}

/** A commit that dies at `point`, leaving the redo after-image behind. */
function crashCommit(graph, point = 'after-prepared') {
  assert.throws(() => commitJsonTransaction(graph, 'op-1', { operations: {} }, (seen) => {
    if (seen === point) throw new Error('process died');
  }), /process died/);
}

describe('Graph JSON journal surface is public (#2343, #2353)', { concurrency: false }, () => {
  it('the snapshot write path reaches the graph through the public strip/write/restore surface', () => {
    const dir = tmpDir('huqan-json-surface-write-');
    const stripped = { 'default::a': [4, 5, 6] };
    const order = [];
    let written = null;
    let restored = null;
    const graph = {
      stripEmbeddings() { order.push('strip'); return stripped; },
      writeStrippedState(embeddings) { order.push('write'); written = embeddings; },
      restoreEmbeddings(embeddings) { order.push('restore'); restored = embeddings; },
    };

    writeCurrentState(graph);

    assert.deepEqual(order, ['strip', 'write', 'restore'],
      'the strip -> write -> restore order must be unchanged');
    assert.deepEqual(written, stripped, 'the stripped vectors are what gets written');
    assert.deepEqual(restored, stripped, 'the very same vectors are restored afterwards');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the snapshot lock and its recovery are taken on the public journal path', () => {
    const dir = tmpDir('huqan-json-surface-lock-');
    const { graph, paths } = publicSurfaceGraph(dir);

    let lockHeldDuringSave = false;
    saveSnapshot(graph, () => { lockHeldDuringSave = fs.existsSync(`${paths.journalPath}.lock`); });

    assert.equal(lockHeldDuringSave, true,
      'the mutation-journal lock must be taken on jsonJournalPath(), not beside it');
    assert.equal(fs.existsSync(`${paths.journalPath}.lock`), false, 'the lock must be released');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the transaction commit publishes through the public surface and reports every fault point', () => {
    const dir = tmpDir('huqan-json-surface-commit-');
    const { graph, log, paths } = publicSurfaceGraph(dir);
    const faults = [];
    const journal = { operations: { 'op-1': { status: 'completed' } } };

    commitJsonTransaction(graph, 'op-1', journal, (point) => faults.push(point));

    assert.deepEqual(faults, [
      'before-prepared', 'after-prepared', 'after-graph-publish',
      'after-embedding-publish', 'after-journal-publish',
    ], 'the hook passed in must see every documented fault point, in order');
    assert.deepEqual(log, ['journalPath', 'strip', 'restore'],
      'the journal path comes from the public accessor and strip -> restore brackets the serialization');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(paths.memoryPath, 'utf8'))).sort(),
      ['auditEvents', 'candidateClaims', 'edges', 'nodes']);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.embeddingPath, 'utf8')), { a: [7, 8, 9] });
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.journalPath, 'utf8')), journal);
    assert.equal(fs.existsSync(redoPathFor(paths.journalPath)), false,
      'a completed commit leaves no after-image behind');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recovery republishes the after-image through the public journal path', () => {
    const dir = tmpDir('huqan-json-surface-recover-');
    const { graph, paths } = publicSurfaceGraph(dir);
    crashCommit(graph);

    const faults = [];
    assert.equal(recoverJsonTransaction(graph, (point) => faults.push(point)), true,
      'recovery must report that it republished an after-image');

    assert.deepEqual(faults, ['before-recovery-cleanup']);
    assert.equal(fs.existsSync(redoPathFor(paths.journalPath)), false, 'the after-image is cleaned up');
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.memoryPath, 'utf8')).nodes, { a: { id: 'a', workspaceId: 'default' } });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a real save() hands the graph-owned fault hook to recovery', () => {
    const dir = tmpDir('huqan-json-surface-recovery-seam-');
    const graph = new Graph({ memoryPath: path.join(dir, 'memory.json'), useSQLite: false });
    graph.addNode('a', 'A', null, { workspaceId: 'w' });
    graph.save();

    // Die after the redo after-image is prepared, before anything is published.
    graph._jsonTransactionFault = (point) => {
      if (point === 'after-prepared') throw new Error('process died');
    };
    assert.throws(() => graph.runMutationOnce('op-1', () => ({ ok: true })), /process died/);

    const seen = [];
    graph._jsonTransactionFault = (point) => seen.push(point);
    graph.save();

    assert.deepEqual(seen, ['before-recovery-cleanup'],
      'save() must hand Graph its own hook rather than let the collaborator read the private name');

    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the promoted members are public on Graph and the private names are gone, not aliased', () => {
    const dir = tmpDir('huqan-json-surface-graph-');
    const graph = new Graph({ memoryPath: path.join(dir, 'memory.json'), useSQLite: false });

    for (const name of ['jsonJournalPath', 'stripEmbeddings', 'writeStrippedState']) {
      assert.equal(typeof graph[name], 'function', `${name} must be public`);
    }
    for (const name of ['_jsonJournalPath', '_stripEmbeddings', '_writeStrippedState']) {
      assert.equal(graph[name], undefined, `${name} must be gone rather than re-exported`);
    }
    assert.equal(graph.jsonJournalPath(), path.join(dir, 'memory.mutations.json'),
      'the public accessor must return the same journal path the backend writes');

    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no collaborator names the private journal surface', () => {
    for (const name of COLLABORATORS) {
      const source = fs.readFileSync(path.join(ROOT, 'lib', name), 'utf8');
      for (const privateName of PRIVATE_SURFACE) {
        assert.doesNotMatch(source, new RegExp(privateName), `${name} must not name ${privateName}`);
      }
    }
    const graphSource = readGraphSurfaceSource();
    for (const privateName of ['_jsonJournalPath', '_stripEmbeddings', '_writeStrippedState']) {
      assert.doesNotMatch(graphSource, new RegExp(privateName),
        `graph.js must neither define nor alias ${privateName}`);
    }
    // The fault hook stays Graph's own test affordance: Graph owns the property
    // and passes it in, so the collaborator never reaches for the name itself.
    assert.match(graphSource, /_jsonTransactionFault/,
      'graph.js must still own the fault-injection seam it hands to the collaborator');
  });
});
