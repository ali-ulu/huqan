'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const Graph = require('../graph');
const { countNodes, countEdges } = require('../lib/graph-count-read');
const { createLabelIndex, rebuildLabelIndex } = require('../lib/graph-label-index');
const { readGraphSurfaceSource } = require('./helpers/graph-surface-source');

const graphSource = readGraphSurfaceSource();
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-count-read.js'), 'utf8');

test('GRAPH: indexed total counts never enumerate the node map; bare maps retain fallback', () => {
  const nodes = { a: { id: 'a' }, b: { id: 'b', workspaceId: 'team' } };
  const index = createLabelIndex();
  rebuildLabelIndex(index, nodes);
  const guarded = new Proxy(nodes, { ownKeys() { assert.fail('total count enumerated nodes'); } });
  assert.equal(countNodes(guarded, undefined, index), 2);
  assert.equal(countNodes(guarded, '', index), 2);
  assert.equal(countNodes(guarded, 'team', index), 1);
  assert.equal(countNodes(nodes), 2);
  assert.equal(countNodes(nodes, '', null), 2);
  assert.equal(countNodes({}, undefined, createLabelIndex()), 0);
});

for (const backend of ['json', 'sqlite']) {
  test(`GRAPH: total count tracks writes, rollback and reopen [${backend}]`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-count-'));
    const options = { memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db'), useSQLite: backend === 'sqlite' };
    let graph = new Graph(options);
    t.after(() => {
      if (graph._db?.open) graph._db.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const check = total => {
      assert.equal(graph.nodeCount(), total);
      assert.equal(graph.nodeCount(''), total);
      assert.equal(Object.keys(graph.getNodes('default')).length + Object.keys(graph.getNodes('team')).length, total);
    };
    check(0);
    graph.addNode('shared', 'first');
    graph.addNode('shared', 'second', null, { workspaceId: 'team' });
    graph.addNode('removed', 'removed', null, { workspaceId: 'team' });
    check(3);
    graph.addNode('shared', 'renamed', null, { workspaceId: 'team' });
    check(3);
    graph.removeNode('removed', 'team');
    check(2);
    assert.equal(graph.nodeCount('default'), 1);
    assert.equal(graph.nodeCount('team'), 1);
    assert.throws(() => graph.runMutationOnce('count-rollback', () => {
      graph.addNode('temporary', 'temporary');
      check(3);
      graph.removeNode('shared', 'team');
      check(2);
      throw new Error('count rollback');
    }), /count rollback/);
    check(2);
    assert.ok(graph.getNode('shared', 'team'));
    assert.equal(graph.getNode('temporary'), null);
    graph.save();
    if (graph._db?.open) graph._db.close();
    graph = new Graph(options);
    graph.load();
    check(2);
    assert.equal(graph.nodeCount('team'), 1);
  });
}

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: nodeCount and edgeCount are one-line delegates', () => {
  assert.equal(methodBody(graphSource, 'nodeCount'), 'return runNodeCount(this._nodes, workspaceId, this._labelIndex);');
  assert.equal(methodBody(graphSource, 'edgeCount'), 'return runEdgeCount(this._edges, workspaceId, this._edgeWorkspaceCounts);');
});

test('GRAPH: count-read delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /workspaceNodeCount/);
});

test('GRAPH: count-read delegate preserves total and workspace-scoped counts', () => {
  const nodes = {
    'default-node': { id: 'default-node', workspaceId: 'default', label: 'a' },
    'workspace-a::one': { id: 'one', workspaceId: 'workspace-a', label: 'a' },
    'workspace-a::two': { id: 'two', workspaceId: 'workspace-a', label: 'b' },
  };
  const edges = [
    { from: 'default-node', to: 'default-node', workspaceId: 'default' },
    { from: 'one', to: 'two', workspaceId: 'workspace-a' },
    { from: 'two', to: 'one', workspaceId: 'workspace-a' },
  ];
  const index = createLabelIndex();
  rebuildLabelIndex(index, nodes);

  assert.equal(countNodes(nodes, undefined, index), 3);
  assert.equal(countNodes(nodes, '', index), 3);
  assert.equal(countNodes(nodes, 'workspace-a', index), 2);
  assert.equal(countNodes(nodes, 'missing', index), 0);
  assert.equal(countEdges(edges), 3);
  assert.equal(countEdges(edges, ''), 3);
  assert.equal(countEdges(edges, 'workspace-a'), 2);
  assert.equal(countEdges(edges, 'missing'), 0);
  const edgeCounts = new Map([['default', 1], ['workspace-a', 2]]);
  assert.equal(countEdges(edges, 'workspace-a', edgeCounts), 2);
  assert.equal(countEdges(edges, 'missing', edgeCounts), 0);
  assert.equal(countEdges(edges, undefined, edgeCounts), 3);
});
