'use strict';

/**
 * #1185: forwardChain/backwardChain de-duplicated with `chain.some(...)`, a
 * linear scan run once per edge, and carried no work or time budget — while
 * detectCycleBounded, directly below them in the same file and reached from the
 * same reason() call, has had both since #743.
 *
 * The Set-based de-duplication is only a speed-up if it selects exactly the
 * same edges in the same order, which is what the equivalence tests check
 * against a transcription of the original.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  forwardChain,
  backwardChain,
  forwardChainBounded,
  backwardChainBounded,
  CHAIN_STOPPED,
} = require('../lib/graph-traversal');

/** Minimal graph stub: the traversal only ever calls these two. */
function makeGraph(edges) {
  return {
    getEdges: (id) => edges.filter(e => e.from === id),
    getInEdges: (id) => edges.filter(e => e.to === id),
  };
}

/** The pre-#1185 implementations, transcribed, as the equivalence reference. */
function forwardReference(graph, id, chain, visited, depth, workspaceId = 'default') {
  if (depth <= 0 || visited.has(id)) return chain;
  visited.add(id);
  for (const e of graph.getEdges(id, workspaceId)) {
    if (!visited.has(e.to) && !chain.some(c => c.to === e.to)) {
      chain.push(e);
      forwardReference(graph, e.to, chain, visited, depth - 1, workspaceId);
    }
  }
  return chain;
}

function backwardReference(graph, id, chain, visited, depth, workspaceId = 'default') {
  if (depth <= 0 || visited.has(id)) return chain;
  visited.add(id);
  for (const e of graph.getInEdges(id, workspaceId)) {
    if (!visited.has(e.from) && !chain.some(c => c.from === e.from)) {
      chain.push(e);
      backwardReference(graph, e.from, chain, visited, depth - 1, workspaceId);
    }
  }
  return chain;
}

const edge = (from, to, relation = 'iliski') => ({ from, to, relation });

describe('#1185 chain traversal matches the scan it replaced', () => {
  const graphs = {
    'simple line': [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
    'hub fan-out': [edge('a', 'b'), edge('a', 'c'), edge('a', 'd')],
    'diamond': [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    'cycle': [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
    'self loop': [edge('a', 'a'), edge('a', 'b')],
    'repeat target': [edge('a', 'b'), edge('a', 'b'), edge('b', 'c')],
    'disconnected': [edge('x', 'y')],
    'empty': [],
  };

  for (const [name, edges] of Object.entries(graphs)) {
    for (const depth of [1, 2, 4, 8]) {
      it(`${name} @ depth ${depth}`, () => {
        const graph = makeGraph(edges);
        assert.deepStrictEqual(
          forwardChain(graph, 'a', [], new Set(), depth, 'default'),
          forwardReference(graph, 'a', [], new Set(), depth, 'default'),
          'forward',
        );
        assert.deepStrictEqual(
          backwardChain(graph, 'd', [], new Set(), depth, 'default'),
          backwardReference(graph, 'd', [], new Set(), depth, 'default'),
          'backward',
        );
      });
    }
  }

  it('agrees on randomized graphs, order included', () => {
    let seed = 20260825;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    for (let round = 0; round < 60; round += 1) {
      const edges = [];
      const count = Math.floor(next() * 14);
      for (let i = 0; i < count; i += 1) {
        edges.push(edge(ids[Math.floor(next() * ids.length)], ids[Math.floor(next() * ids.length)]));
      }
      const graph = makeGraph(edges);
      const depth = 1 + Math.floor(next() * 5);
      const label = `round ${round}: ${JSON.stringify(edges.map(e => `${e.from}->${e.to}`))} @ ${depth}`;

      assert.deepStrictEqual(
        forwardChain(graph, 'a', [], new Set(), depth, 'default'),
        forwardReference(graph, 'a', [], new Set(), depth, 'default'),
        `forward ${label}`,
      );
      assert.deepStrictEqual(
        backwardChain(graph, 'a', [], new Set(), depth, 'default'),
        backwardReference(graph, 'a', [], new Set(), depth, 'default'),
        `backward ${label}`,
      );
    }
  });

  it('a non-empty starting chain suppresses the same targets the scan did', () => {
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const graph = makeGraph(edges);
    const seededChain = () => [edge('seed', 'b')];

    assert.deepStrictEqual(
      forwardChain(graph, 'a', seededChain(), new Set(), 3, 'default'),
      forwardReference(graph, 'a', seededChain(), new Set(), 3, 'default'),
    );
  });
});

describe('#1185 chain traversal is bounded', () => {
  function wideGraph(fanout) {
    const edges = [];
    for (let i = 0; i < fanout; i += 1) edges.push(edge('hub', 't' + i));
    return makeGraph(edges);
  }

  it('reports completion when it finishes within budget', () => {
    const result = forwardChainBounded(wideGraph(10), 'hub', [], new Set(), 4, 'default');
    assert.equal(result.stoppedReason, CHAIN_STOPPED.COMPLETE);
    assert.equal(result.chain.length, 10);
  });

  it('stops on maxNodes and says so instead of returning a silently short chain', () => {
    const graph = makeGraph([edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e')]);
    const result = forwardChainBounded(graph, 'a', [], new Set(), 10, 'default', { maxNodes: 2 });

    assert.equal(result.stoppedReason, CHAIN_STOPPED.MAX_NODES);
    assert.ok(result.chain.length < 4, 'the chain is incomplete, which is why the reason matters');
  });

  it('stops on timeoutMs', () => {
    // A graph stub that stalls long enough for any positive timeout to expire.
    const slow = {
      getEdges: (id) => {
        const until = Date.now() + 5;
        while (Date.now() < until) { /* burn */ }
        return id === 'a' ? [edge('a', 'b')] : [edge(id, id + 'x')];
      },
      getInEdges: () => [],
    };
    const result = forwardChainBounded(slow, 'a', [], new Set(), 50, 'default', { timeoutMs: 1 });
    assert.equal(result.stoppedReason, CHAIN_STOPPED.TIMEOUT);
  });

  it('backward traversal is bounded on the same terms', () => {
    const graph = makeGraph([edge('b', 'a'), edge('c', 'b'), edge('d', 'c')]);
    const result = backwardChainBounded(graph, 'a', [], new Set(), 10, 'default', { maxNodes: 2 });
    assert.equal(result.stoppedReason, CHAIN_STOPPED.MAX_NODES);
  });

  it('the legacy wrappers still return the chain array', () => {
    const graph = wideGraph(5);
    assert.ok(Array.isArray(forwardChain(graph, 'hub', [], new Set(), 4, 'default')));
    assert.ok(Array.isArray(backwardChain(graph, 't0', [], new Set(), 4, 'default')));
  });

  it('fan-out cost is no longer quadratic', () => {
    const time = (fanout) => {
      const graph = wideGraph(fanout);
      const started = process.hrtime.bigint();
      forwardChain(graph, 'hub', [], new Set(), 4, 'default');
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    time(500); // warm up
    const small = time(1000);
    const large = time(4000);

    // Quadratic is ~16x for a 4x fan-out increase, which is what the pre-fix
    // measurement showed. The ceiling is loose enough not to be timing-flaky.
    const growth = large / Math.max(small, 0.05);
    assert.ok(growth < 10, `fan-out 1000 -> 4000 grew ${growth.toFixed(1)}x, expected well under quadratic`);
  });
});
