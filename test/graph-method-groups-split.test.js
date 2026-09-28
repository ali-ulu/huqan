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
// The prototype surface is pinned to a digest recorded on main before the
// move: every name, its arity and its descriptor flags.

const MAIN_SURFACE = { count: 77, sha256: 'ef64220c6be39a479fbbf4c9ff2c5adcf4555db2bf99420cfd949e0c26782bce' };

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
