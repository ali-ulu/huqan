'use strict';

// #3844: cycle detection must follow edge direction, and reason() must keep
// taxonomy apart from causation. These pin the two behaviours the fix
// introduced, the cycle-order helper that now reports a start node, and the
// reason/compare/entropy branches the change added.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const Kernel = require('../kernel');
const {
  detectCycleBounded,
  detectCycleResult,
  resolveCycleOrder,
} = require('../lib/graph-cycle-search');

const WS = 'workspace-cycle-direction';

/** The cycle search only ever calls getEdges; the rest is not reached. */
function stubGraph(edges) {
  return { getEdges: (id) => edges.filter((e) => e.from === id) };
}

function makeKernel(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cycle-direction-'));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
  t.after(() => {
    kernel.graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return kernel;
}

describe('directed cycle detection', () => {
  it('skips a visited node that is not on the current path', () => {
    const graph = stubGraph([
      { from: 'start', to: 'ghost' },
      { from: 'start', to: 'leaf' },
    ]);
    // `ghost` is already visited but absent from the path, so reaching it is not
    // a cycle: the frame must be popped, not reported.
    const result = detectCycleBounded(graph, 'start', { visited: new Set(['ghost']) });
    assert.equal(result.cycle, null);
    assert.equal(result.stoppedReason, '');
  });

  it('follows only out-edges, so two children of one parent are not a cycle', () => {
    const graph = stubGraph([
      { from: 'kedi', to: 'hayvan' },
      { from: 'kopek', to: 'hayvan' },
    ]);
    assert.equal(detectCycleBounded(graph, 'kedi').cycle, null);
  });

  it('detectCycleResult tolerates a missing visited set and path', () => {
    const graph = stubGraph([{ from: 'a', to: 'a' }]);
    assert.deepEqual(detectCycleResult(graph, 'a', null, null).cycle, ['a', 'a']);
  });
});

describe('resolveCycleOrder names the cycle start from taxonomy edges', () => {
  it('returns the node carried by a tür edge that is not also its target', () => {
    const graph = stubGraph([
      { from: 'a', to: 'b', relation: 'tür' },
      { from: 'b', to: 'a', relation: 'causes' },
    ]);
    assert.equal(resolveCycleOrder(graph, ['a', 'b', 'a']), 'a (döngü başlangıcı)');
  });

  it('returns null when no edge in the cycle is taxonomic', () => {
    const graph = stubGraph([
      { from: 'a', to: 'b', relation: 'causes' },
      { from: 'b', to: 'a', relation: 'causes' },
    ]);
    assert.equal(resolveCycleOrder(graph, ['a', 'b', 'a']), null);
  });
});

describe('reason buckets edges by family', () => {
  it('files a non-causal backward edge under "buna bağlı", not "nedeni"', (t) => {
    const kernel = makeKernel(t);
    for (const id of ['kedi', 'hayvan', 'dunya']) {
      kernel.graph.addNode(id, id, null, { workspaceId: WS });
    }
    kernel.graph.addEdge('kedi', 'hayvan', 'tür', { weight: 0.5, workspaceId: WS });
    kernel.graph.addEdge('dunya', 'kedi', 'related_to', { weight: 0.5, workspaceId: WS });

    const answer = kernel.reason('kedi', WS).data.answer;
    assert.equal(answer, [
      'kedi:',
      '  üst tür: hayvan [tür]',
      '  buna bağlı: dunya [related_to]',
    ].join('\n'));
  });

  it('reports zero entropy when every edge weight is zero', (t) => {
    const kernel = makeKernel(t);
    for (const id of ['a', 'b']) kernel.graph.addNode(id, id, null, { workspaceId: WS });
    kernel.graph.addEdge('a', 'b', 'related_to', { weight: 0, workspaceId: WS });
    assert.equal(kernel.entropy(WS), 0);
  });
});

describe('compare lists each side\'s unique edge and omits a missing path', () => {
  it('names both unique sets and carries no path when the nodes are unconnected', (t) => {
    const kernel = makeKernel(t);
    for (const id of ['a', 'b', 'x', 'y']) kernel.graph.addNode(id, id, null, { workspaceId: WS });
    kernel.graph.addEdge('a', 'x', 'related_to', { weight: 0.5, workspaceId: WS });
    kernel.graph.addEdge('b', 'y', 'related_to', { weight: 0.5, workspaceId: WS });

    const result = kernel.compare('a', 'b', WS).data;
    assert.equal(result.answer, [
      '\u{1F4CA} a vs b:',
      '  sadece a: x [related_to]',
      '  sadece b: y [related_to]',
    ].join('\n'));
    assert.deepEqual(result.paths, []);
  });
});
