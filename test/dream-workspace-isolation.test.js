'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Dream = require('../dream');
const { Graph } = require('../graph');

function fixture() {
  const graph = new Graph({ noLoad: true });
  const dream = new Dream({ graph, plugins: { emit() {} } });
  return { dream, graph };
}

function addPath(graph, workspaceId, from, to, weight) {
  graph.addNode(from, from, null, { workspaceId });
  graph.addNode(to, to, null, { workspaceId });
  graph.addEdge(from, to, 'tür', { workspaceId, weight, confidence: weight });
  graph.getEdge(from, to, 'tür', workspaceId).weight = weight;
}

test('amplify scores only candidates reachable in the explicitly requested workspace', () => {
  const { dream, graph } = fixture();
  addPath(graph, 'default', 'shared-source', 'default-target', 0.9);
  addPath(graph, 'tenant-b', 'shared-source', 'tenant-target', 0.8);

  const defaultBefore = graph.getEdge('shared-source', 'default-target', 'tür', 'default').weight;
  const tenantBefore = graph.getEdge('shared-source', 'tenant-target', 'tür', 'tenant-b').weight;

  const ranked = dream.amplify(
    'shared-source',
    ['default-target', 'tenant-target'],
    'tür',
    { workspaceId: ' tenant-b ' },
  );

  assert.equal(ranked[0], 'tenant-target');
  assert.equal(graph.getEdge('shared-source', 'default-target', 'tür', 'default').weight, defaultBefore);
  assert.equal(graph.getEdge('shared-source', 'tenant-target', 'tür', 'tenant-b').weight, tenantBefore);
});

test('verify keeps DFS and path confidence inside one normalized workspace', () => {
  const { dream, graph } = fixture();
  addPath(graph, 'default', 'shared-source', 'default-only', 0.3);
  addPath(graph, 'tenant-b', 'shared-source', 'tenant-middle', 0.8);
  addPath(graph, 'tenant-b', 'tenant-middle', 'tenant-target', 0.5);

  const scoped = dream.verify('shared-source', 'tenant-target', { workspaceId: ' tenant-b ' });
  const unscoped = dream.verify('shared-source', 'tenant-target');

  assert.deepEqual(scoped.path, ['shared-source', 'tenant-middle', 'tenant-target']);
  assert.equal(scoped.valid, true);
  assert.equal(scoped.confidence, 0.4);
  assert.deepEqual(unscoped, { valid: false, confidence: 0, path: [] });
});

test('simulate and walk never surface an identically named node from another workspace', () => {
  const { dream, graph } = fixture();
  addPath(graph, 'default', 'shared-source', 'default-target', 0.9);
  addPath(graph, 'tenant-b', 'shared-source', 'tenant-target', 0.7);

  const simulated = dream.simulate('shared-source', { workspaceId: ' tenant-b ' });
  const walked = dream.walk('shared-source', 1, { workspaceId: ' tenant-b ' });

  assert.deepEqual(simulated.map(item => item.answer), ['tenant-target']);
  assert.deepEqual(walked, ['shared-source', 'tenant-target']);
  assert.ok(simulated.every(item => item.answer !== 'default-target'));
});

test('legacy calls retain default-workspace behavior', () => {
  const { dream, graph } = fixture();
  addPath(graph, 'default', 'source', 'target', 0.9);
  addPath(graph, 'tenant-b', 'source', 'tenant-target', 0.8);

  assert.equal(dream.verify('source', 'target').valid, true);
  assert.equal(dream.verify('source', 'tenant-target').valid, false);
  assert.deepEqual(dream.simulate('source').map(item => item.answer), ['target']);
  assert.deepEqual(dream.walk('source', 1), ['source', 'target']);
});

test('all graph reads receive the same normalized workspace value', () => {
  const { dream, graph } = fixture();
  addPath(graph, 'tenant-b', 'source', 'target', 0.9);
  const observed = [];

  for (const method of ['getEdge', 'getNode', 'getEdges', 'getInEdges', 'cosineSimilarity']) {
    const original = graph[method].bind(graph);
    graph[method] = (...args) => {
      observed.push({ method, workspaceId: args[args.length - 1] });
      return original(...args);
    };
  }

  dream.amplify('source', ['target'], 'tür', { workspaceId: ' tenant-b ' });
  dream.verify('source', 'target', { workspaceId: ' tenant-b ' });
  dream.simulate('source', { workspaceId: ' tenant-b ' });
  dream.walk('source', 1, { workspaceId: ' tenant-b ' });

  assert.ok(observed.length > 0);
  assert.ok(observed.every(call => call.workspaceId === 'tenant-b'), JSON.stringify(observed));
});
