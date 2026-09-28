'use strict';

// #3009 end-to-end: the label index must stay consistent through the real
// write paths (addNode/removeNode/optimize/reload) and a label query must not
// enumerate the node map. The enumeration proof uses a Proxy that counts
// `ownKeys` traps: `Object.values(nodes)` would trigger it once, while an
// index lookup only reads the matching keys.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Graph = require('../graph');
const { isolatedGraphOptions } = require('./helpers/isolated-persistence');

function countingNodes(nodes) {
  const counter = { ownKeys: 0 };
  const proxy = new Proxy(nodes, {
    ownKeys(target) {
      counter.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
  });
  return { proxy, counter };
}

test('GRAPH #3009: query tracks label changes and deletions across workspaces', () => {
  const g = new Graph(isolatedGraphOptions('graph-3009', { useSQLite: false }));
  g.addNode('dog', 'animal', null, { workspaceId: 'default' });
  g.addNode('cat', 'animal', null, { workspaceId: 'team' });
  g.addNode('table', 'object', null, { workspaceId: 'team' });

  assert.deepEqual(g.query('animal', 'default').map(n => n.id), ['dog']);
  assert.deepEqual(g.query('animal', 'team').map(n => n.id), ['cat']);
  assert.deepEqual(g.query('object', 'default'), []);

  // Re-adding an existing id with a new label must move it out of the old bucket.
  g.addNode('dog', 'pet', null, { workspaceId: 'default' });
  assert.deepEqual(g.query('animal', 'default'), []);
  assert.deepEqual(g.query('pet', 'default').map(n => n.id), ['dog']);

  // Deletion must drop the node from its bucket.
  assert.equal(g.removeNode('cat', 'team'), true);
  assert.deepEqual(g.query('animal', 'team'), []);

  // A deleted node must not be resurrected by a stale bucket entry.
  g.addNode('cat', 'animal', null, { workspaceId: 'team' });
  assert.deepEqual(g.query('animal', 'team').map(n => n.id), ['cat']);
});

test('GRAPH #3009: nodeCount matches a full scan for every workspace', () => {
  const g = new Graph(isolatedGraphOptions('graph-3009-count', { useSQLite: false }));
  for (let i = 0; i < 25; i++) g.addNode(`a${i}`, 'animal', null, { workspaceId: 'default' });
  for (let i = 0; i < 10; i++) g.addNode(`b${i}`, 'object', null, { workspaceId: 'team' });

  assert.equal(g.nodeCount(), 35);
  assert.equal(g.nodeCount('default'), 25);
  assert.equal(g.nodeCount('team'), 10);
  assert.equal(g.nodeCount('missing'), 0);

  g.removeNode('a0', 'default');
  assert.equal(g.nodeCount('default'), 24);
});

test('GRAPH #3009: a label query does not enumerate the node map', () => {
  const g = new Graph(isolatedGraphOptions('graph-3009-scan', { useSQLite: false }));
  for (let i = 0; i < 200; i++) g.addNode(`n${i}`, i % 2 ? 'even' : 'odd', null, { workspaceId: 'default' });

  const { proxy, counter } = countingNodes(g._nodes);
  g._nodes = proxy;

  const hits = g.query('odd', 'default');
  assert.equal(hits.length, 100);
  assert.equal(counter.ownKeys, 0, 'query must read the index, not scan _nodes');

  // Scoped nodeCount is index-backed too; the total count is allowed to scan.
  assert.equal(g.nodeCount('default'), 200);
  assert.equal(counter.ownKeys, 0, 'scoped nodeCount must read the index, not scan _nodes');
});

test('GRAPH #3009: workspace getNodes does not enumerate the node map', () => {
  const g = new Graph(isolatedGraphOptions('graph-3009-getnodes', { useSQLite: false }));
  for (let i = 0; i < 120; i++) g.addNode(`n${i}`, 'thing', null, { workspaceId: i % 3 ? 'default' : 'team' });

  const { proxy, counter } = countingNodes(g._nodes);
  g._nodes = proxy;

  const team = g.getNodes('team');
  assert.equal(Object.keys(team).length, 40);
  assert.equal(counter.ownKeys, 0, 'workspace getNodes must read the index, not scan _nodes');
});

test('GRAPH #3009: optimize visits only the target workspace', () => {
  const g = new Graph(isolatedGraphOptions('graph-3009-optimize', { useSQLite: false }));
  for (let i = 0; i < 60; i++) g.addNode(`keep${i}`, 'thing', null, { workspaceId: 'default' });
  for (let i = 0; i < 30; i++) g.addNode(`team${i}`, 'thing', null, { workspaceId: 'team' });

  const { proxy, counter } = countingNodes(g._nodes);
  g._nodes = proxy;

  const result = g.optimize('team');
  assert.equal(typeof result.removedNodes, 'number');
  assert.equal(counter.ownKeys, 0, 'optimize must read the index, not scan _nodes');
});

test('GRAPH #3009: index survives a JSON reload', () => {
  const opts = isolatedGraphOptions('graph-3009-reload', { useSQLite: false });
  const g = new Graph(opts);
  g.addNode('alpha', 'animal', null, { workspaceId: 'default' });
  g.addNode('beta', 'animal', null, { workspaceId: 'team' });
  g.save();

  const reloaded = new Graph(opts);
  reloaded.load();
  assert.deepEqual(reloaded.query('animal', 'default').map(n => n.id), ['alpha']);
  assert.deepEqual(reloaded.query('animal', 'team').map(n => n.id), ['beta']);
  assert.equal(reloaded.nodeCount('team'), 1);
});
