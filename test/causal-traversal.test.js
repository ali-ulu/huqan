'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  traverseCausalGraph,
} = require('../lib/causal');

function createAdapter(nodes, edges) {
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  return {
    getNode(id) {
      return nodeMap.get(id) || null;
    },
    getEdges(id) {
      return edges.filter(edge => edge.from === id || edge.fromId === id || edge.from_id === id || edge.source === id);
    },
  };
}

function edge(id, from, to, relation, extra = {}) {
  return {
    id,
    from,
    to,
    relation,
    strength: extra.strength ?? 0.8,
    ...extra,
  };
}

function traversalIds(result) {
  return result.traversal.traversalOrder.map(entry => `${entry.from}->${entry.to}:${entry.relation}:${entry.edgeId || ''}`);
}

test('linear chain traverses in depth order', () => {
  const adapter = createAdapter(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [
      edge('e1', 'A', 'B', 'CAUSES'),
      edge('e2', 'B', 'C', 'ENABLES'),
    ],
  );

  const result = traverseCausalGraph(adapter, 'A');

  assert.equal(result.traversal.completed, true);
  assert.equal(result.traversal.stopReason, 'terminus');
  assert.deepEqual(traversalIds(result), ['A->B:CAUSES:e1', 'B->C:ENABLES:e2']);
  assert.equal(result.traversal.maxDepthReached, 2);
  assert.equal(result.traversal.visitedEdgeCount, 2);
});

test('branch ordering is deterministic by relation priority and ids', () => {
  const adapter = createAdapter(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }],
    [
      edge('z-edge', 'A', 'F', 'PREVENTS'),
      edge('b-edge', 'A', 'C', 'ENABLES'),
      edge('a-edge', 'A', 'B', 'CAUSES'),
      edge('d-edge', 'A', 'E', 'DEPENDS_ON'),
      edge('c-edge', 'A', 'D', 'LEADS_TO'),
    ],
  );

  const first = traverseCausalGraph(adapter, 'A');
  const second = traverseCausalGraph(adapter, 'A');

  assert.deepEqual(first, second);
  assert.deepEqual(traversalIds(first), [
    'A->B:CAUSES:a-edge',
    'A->C:ENABLES:b-edge',
    'A->D:LEADS_TO:c-edge',
    'A->E:DEPENDS_ON:d-edge',
    'A->F:PREVENTS:z-edge',
  ]);
});

test('depth-first traversal exhausts each branch before visiting its sibling', () => {
  const adapter = createAdapter(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
    [
      edge('e1', 'A', 'B', 'CAUSES'),
      edge('e2', 'A', 'C', 'CAUSES'),
      edge('e3', 'B', 'D', 'CAUSES'),
      edge('e4', 'D', 'E', 'CAUSES'),
    ],
  );

  const result = traverseCausalGraph(adapter, 'A');

  assert.deepEqual(traversalIds(result), [
    'A->B:CAUSES:e1',
    'B->D:CAUSES:e3',
    'D->E:CAUSES:e4',
    'A->C:CAUSES:e2',
  ]);
});

test('deep chain traversal does not consume the JavaScript call stack', () => {
  const edgeCount = 12_000;
  const outgoing = new Map();
  for (let index = 0; index < edgeCount; index += 1) {
    outgoing.set(`N${index}`, [edge(`e${index}`, `N${index}`, `N${index + 1}`, 'CAUSES')]);
  }

  const adapter = {
    getNode(id) {
      const index = Number(id.slice(1));
      return Number.isInteger(index) && index >= 0 && index <= edgeCount ? { id } : null;
    },
    getEdges(id) {
      return outgoing.get(id) || [];
    },
  };

  const result = traverseCausalGraph(adapter, 'N0');

  assert.equal(result.traversal.completed, true);
  assert.equal(result.traversal.visitedEdgeCount, edgeCount);
  assert.equal(result.traversal.maxDepthReached, edgeCount);
  assert.equal(result.traversal.traversalOrder.at(-1).to, `N${edgeCount}`);
});

test('maxDepth blocks deeper hops but keeps partial traversal', () => {
  const adapter = createAdapter(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [
      edge('e1', 'A', 'B', 'CAUSES'),
      edge('e2', 'B', 'C', 'CAUSES'),
    ],
  );

  const result = traverseCausalGraph(adapter, 'A', { maxDepth: 1 });

  assert.equal(result.traversal.completed, false);
  assert.equal(result.traversal.stopReason, 'depth_exceeded');
  assert.deepEqual(result.traversal.stopReasons, ['depth_exceeded']);
  assert.equal(result.traversal.visitedEdgeCount, 1);
  assert.equal(result.traversal.maxDepthReached, 1);
  assert.equal(result.traversal.blockedBranches.length, 1);
  assert.equal(result.traversal.blockedBranches[0].reason, 'depth_exceeded');
});

test('cycle detection is path-local and stops the branch hard', () => {
  const adapter = createAdapter(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [
      edge('e1', 'A', 'B', 'CAUSES'),
      edge('e2', 'B', 'C', 'CAUSES'),
      edge('e3', 'C', 'A', 'CAUSES'),
    ],
  );

  const result = traverseCausalGraph(adapter, 'A');

  assert.equal(result.traversal.completed, false);
  assert.equal(result.traversal.stopReason, 'cycle_detected');
  assert.deepEqual(result.traversal.stopReasons, ['cycle_detected']);
  assert.deepEqual(result.traversal.cycleNodeIds, ['A']);
  assert.deepEqual(result.traversal.cycleEdgeIds, ['e3']);
  assert.equal(result.traversal.blockedBranches.length, 1);
  assert.equal(result.traversal.blockedBranches[0].reason, 'cycle_detected');
});

test('convergent dag is not treated as a cycle', () => {
  const adapter = createAdapter(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [
      edge('e1', 'A', 'B', 'CAUSES'),
      edge('e2', 'A', 'C', 'CAUSES'),
      edge('e3', 'B', 'D', 'CAUSES'),
      edge('e4', 'C', 'D', 'CAUSES'),
    ],
  );

  const result = traverseCausalGraph(adapter, 'A');

  assert.equal(result.traversal.stopReason, 'terminus');
  assert.deepEqual(result.traversal.cycleNodeIds, []);
  assert.deepEqual(result.traversal.cycleEdgeIds, []);
  assert.deepEqual(result.traversal.blockedBranches, []);
  assert.equal(result.traversal.visitedEdgeCount, 4);
});

test('global finished-node tracking bounds convergent DAG traversal', () => {
  const layers = 16;
  const edges = [];
  let edgeId = 0;
  for (let index = 0; index < layers; index += 1) {
    const current = `L${index}`;
    const next = `L${index + 1}`;
    for (const middle of [`a${index}`, `b${index}`]) {
      edges.push(edge(`e${edgeId++}`, current, middle, 'CAUSES'));
      edges.push(edge(`e${edgeId++}`, middle, next, 'CAUSES'));
    }
  }
  const nodes = [{ id: 'L0' }];
  for (let index = 1; index <= layers; index += 1) {
    nodes.push({ id: `L${index}` }, { id: `a${index - 1}` }, { id: `b${index - 1}` });
  }

  const result = traverseCausalGraph(createAdapter(nodes, edges), 'L0');

  assert.equal(result.traversal.completed, true);
  assert.equal(result.traversal.stopReason, 'terminus');
  assert.equal(result.traversal.visitedEdgeCount, edges.length);
  assert.equal(result.traversal.traversalOrder.length, edges.length);
  assert.equal(result.traversal.visitedNodeCount, nodes.length);
});

test('missing start produces missing_start without traversal', () => {
  const adapter = createAdapter([], []);

  const result = traverseCausalGraph(adapter, 'A');

  assert.equal(result.traversal.completed, false);
  assert.equal(result.traversal.stopReason, 'missing_start');
  assert.deepEqual(result.traversal.stopReasons, ['missing_start']);
  assert.equal(result.traversal.visitedEdgeCount, 0);
  assert.equal(result.traversal.traversalOrder.length, 0);
});

test('empty graph with a known start terminates cleanly', () => {
  const adapter = createAdapter([{ id: 'A' }], []);

  const result = traverseCausalGraph(adapter, 'A');

  assert.equal(result.traversal.completed, true);
  assert.equal(result.traversal.stopReason, 'terminus');
  assert.equal(result.traversal.visitedEdgeCount, 0);
  assert.equal(result.traversal.traversalOrder.length, 0);
});

test('maxEdges stops traversal globally after the allowed number of edges', () => {
  const adapter = createAdapter(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [
      edge('e1', 'A', 'B', 'CAUSES'),
      edge('e2', 'A', 'C', 'ENABLES'),
      edge('e3', 'A', 'D', 'LEADS_TO'),
    ],
  );

  const result = traverseCausalGraph(adapter, 'A', { maxEdges: 2 });

  assert.equal(result.traversal.completed, false);
  assert.equal(result.traversal.stopReason, 'max_edges_exceeded');
  assert.deepEqual(result.traversal.stopReasons, ['max_edges_exceeded']);
  assert.equal(result.traversal.visitedEdgeCount, 2);
  assert.equal(result.traversal.blockedBranches.length, 1);
  assert.equal(result.traversal.blockedBranches[0].reason, 'max_edges_exceeded');
});

test('non-causal edges are ignored when only getEdges is available', () => {
  const adapter = {
    getNode(id) {
      return id === 'A' || id === 'B' ? { id } : null;
    },
    getEdges(id) {
      if (id !== 'A') return [];
      return [
        edge('e1', 'A', 'B', 'CAUSES'),
        edge('e2', 'A', 'B', 'related_to'),
      ];
    },
  };

  const result = traverseCausalGraph(adapter, 'A');

  assert.equal(result.traversal.visitedEdgeCount, 1);
  assert.deepEqual(traversalIds(result), ['A->B:CAUSES:e1']);
});
