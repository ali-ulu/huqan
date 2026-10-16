'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { readGraphSurfaceSource, graphMethodHolders } = require('./helpers/graph-surface-source');

// #3101: graph.js required 31 distinct modules (FANOUT:31). Its read, write and
// mutation-journal methods move unchanged into lib/graph-read-methods.js,
// lib/graph-write-methods.js and lib/graph-journal-methods.js, installed on
// Graph.prototype with the descriptors they had as class members. The
// persistence wiring the constructor owns, the audit append and the
// consolidate maintenance audit stay in graph.js.
//
// The prototype surface is pinned to a digest: every name, its arity and its
// descriptor flags. #3009 added five internal label-index/rebuild helpers
// (_labelIndexOrCreate, _indexLabelNode, _deindexLabelNode, _workspaceNodeKeys,
// _rebuildEdgeIndex), so the count and digest moved with them. #3139 added
// _edgeWorkspaceCountsOrCreate for the per-workspace edge counter. #3011 added
// _dirtyOrCreate, _nextSaveMode, _checkpointEvery and _afterSave for the
// incremental-save delta bookkeeping. #3017 added three internal vector-index
// helpers (_vectorIndexOrCreate, _indexVectorNode, _deindexVectorNode) plus the
// public similarityCandidateIds reader (via lib/graph-read-methods.js). The
// #3017 follow-up added the public nearestSimilarNode reader (exact top-1
// cosine with an early stop). #3188 added the two public seal readers
// getMutationReceiptSealByHash and getMutationReceiptSealByOperation (via
// lib/graph-journal-methods.js). R35 adds the public seal verifier
// verifyMutationReceiptSealByOperation (via lib/graph-journal-methods.js,
// seal primitive injected through mutationReceiptDeps). The public method
// names above are unchanged.

const MAIN_SURFACE = { count: 95, sha256: 'db7061d0201446297635a1cbf60b505f5873bea95f50d41554e40dbcd54c8073' };

test('Graph.prototype keeps the exact surface it had on main', () => {
  const proto = require('../graph').prototype;
  const rows = Object.getOwnPropertyNames(proto).sort().map((name) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    return [name, typeof d.value === 'function' ? d.value.length : 'get', d.enumerable, d.writable, d.configurable];
  });
  assert.equal(rows.length, MAIN_SURFACE.count);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'), MAIN_SURFACE.sha256);
});

test('graph.js installs its method groups and the surface helper reads every one', () => {
  assert.deepEqual(graphMethodHolders(), [
    'lib/graph-journal-methods.js', 'lib/graph-read-methods.js', 'lib/graph-write-methods.js',
  ]);
  const surface = readGraphSurfaceSource();
  for (const name of ['getEdge', 'addEdge', 'runMutationOnce', 'consolidateEdges']) {
    assert.match(surface, new RegExp(`\\n  ${name}\\(`), name);
  }
});

test('graph.js has left the FANOUT tracker', () => {
  const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'graph.js');
  assert.ok(row, 'the file is measured');
  assert.ok(!row.signals.some((signal) => signal.startsWith('FANOUT')), JSON.stringify(row));
});
