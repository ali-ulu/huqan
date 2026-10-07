'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');

function makeKernel(label, overrides = {}) {
  // `root` lets a caller supply the directory (so a test can assert on exact
  // paths); otherwise each kernel gets its own mkdtemp directory.
  const { root: rootOverride, ...kernelOptions } = overrides;
  const root = rootOverride || fs.mkdtempSync(path.join(os.tmpdir(), `huqan-read-use-cases-${label}-`));
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
    ...kernelOptions,
  });
}

function closeKernel(kernel) {
  kernel.graph.close();
  kernel.memory.close();
}

test('Kernel delegates entropy and gap inspection through read use cases', () => {
  const kernel = makeKernel('delegation');
  const calls = [];
  const originalAsk = kernel._readUseCases.ask;
  const originalGetPersistenceDescriptor = kernel._readUseCases.getPersistenceDescriptor;
  const originalEntropy = kernel._readUseCases.entropy;
  const originalDetectGaps = kernel._readUseCases.detectGaps;
  const originalReason = kernel._readUseCases.reason;
  const originalCompare = kernel._readUseCases.compare;

  kernel._readUseCases = {
    ask(question) {
      calls.push(['ask', question]);
      return originalAsk(question);
    },
    getPersistenceDescriptor() {
      calls.push(['getPersistenceDescriptor']);
      return originalGetPersistenceDescriptor();
    },
    entropy(workspaceId) {
      calls.push(['entropy', workspaceId]);
      return originalEntropy(workspaceId);
    },
    detectGaps(workspaceId) {
      calls.push(['detectGaps', workspaceId]);
      return originalDetectGaps(workspaceId);
    },
    reason(subject, workspaceId) {
      calls.push(['reason', subject, workspaceId]);
      return originalReason(subject, workspaceId);
    },
    compare(a, b, workspaceId) {
      calls.push(['compare', a, b, workspaceId]);
      return originalCompare(a, b, workspaceId);
    },
  };

  try {
    assert.equal(kernel.ask('bilinmeyen nedir').type, 'ask');
    assert.equal(kernel.getPersistenceDescriptor().memoryPath.endsWith('memory.json'), true);
    assert.equal(kernel.entropy('workspace-a'), 0);
    assert.deepEqual(kernel.detectGaps('workspace-a'), []);
    assert.equal(kernel.reason('subject-a', 'workspace-a').type, 'reason');
    assert.equal(kernel.compare('subject-a', 'subject-b', 'workspace-a').type, 'compare');
    assert.deepEqual(calls, [
      ['ask', 'bilinmeyen nedir'],
      ['getPersistenceDescriptor'],
      ['entropy', 'workspace-a'],
      ['detectGaps', 'workspace-a'],
      ['reason', 'subject-a', 'workspace-a'],
      ['compare', 'subject-a', 'subject-b', 'workspace-a'],
    ]);
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve persistence descriptor observable results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-read-use-cases-persistence-descriptor-'));
  const kernel = makeKernel('persistence-descriptor', {
    root,
    // Deliberately a different dbPath: the descriptor must derive dbPath from
    // memoryPath, not echo the configured dbPath.
    dbPath: path.join(root, 'independent.db'),
  });

  try {
    const descriptor = kernel.getPersistenceDescriptor();

    assert.deepEqual(descriptor, {
      memoryPath: path.join(root, 'memory.json'),
      dbPath: path.join(root, 'memory.db'),
    });
    assert.equal(Object.isFrozen(descriptor), true);
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve entropy and detectGaps observable results', () => {
  const kernel = makeKernel('parity');

  try {
    kernel.graph.addNode('a', 'a', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('b', 'b', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('c', 'c', null, { workspaceId: 'workspace-a' });
    kernel.graph.addEdge('a', 'b', 'related', { weight: 0.25, workspaceId: 'workspace-a' });
    kernel.graph.addEdge('a', 'c', 'related', { weight: 0.75, workspaceId: 'workspace-a' });

    const expectedEntropy = -((0.25 / 1) * Math.log(0.25 / 1)) - ((0.75 / 1) * Math.log(0.75 / 1));

    assert.equal(kernel.entropy('workspace-a'), expectedEntropy);
    assert.deepEqual(kernel.detectGaps('workspace-a'), ['b', 'c']);
    assert.equal(kernel.entropy('workspace-b'), 0);
    assert.deepEqual(kernel.detectGaps('workspace-b'), []);
  } finally {
    closeKernel(kernel);
  }
});

test('entropy ignores zero-weight edges when positive edges exist', () => {
  const kernel = makeKernel('zero-weight-entropy');

  try {
    kernel.graph.addNode('source', 'source', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('zero', 'zero', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('positive', 'positive', null, { workspaceId: 'workspace-a' });
    kernel.graph.addEdge('source', 'zero', 'related', { weight: 0, workspaceId: 'workspace-a' });
    kernel.graph.addEdge('source', 'positive', 'related', { weight: 1, workspaceId: 'workspace-a' });

    assert.equal(kernel.entropy('workspace-a'), 0);
    assert.equal(Number.isNaN(kernel.entropy('workspace-a')), false);
  } finally {
    closeKernel(kernel);
  }
});

test('entropy and detectGaps read the workspace edges once, through frozen views', () => {
  // #3012: these two are the whole-workspace reads of the analysis use cases.
  // They used to scan every node with a getEdges(node.id) call; they now take
  // one workspace edge read. Pin the contract: a single getAllEdges per call,
  // opted out of the deep clone, and no per-node getEdges at all.
  const kernel = makeKernel('frozen-reads');

  try {
    const WS = 'workspace-a';
    kernel.graph.addNode('a', 'a', null, { workspaceId: WS });
    kernel.graph.addNode('b', 'b', null, { workspaceId: WS });
    kernel.graph.addNode('c', 'c', null, { workspaceId: WS });
    kernel.graph.addEdge('a', 'b', 'related', { weight: 0.25, workspaceId: WS });
    kernel.graph.addEdge('a', 'c', 'related', { weight: 0.75, workspaceId: WS });

    const graph = kernel.graph;
    const calls = { allEdges: [], edges: [] };
    const realAllEdges = graph.getAllEdges.bind(graph);
    const realGetEdges = graph.getEdges.bind(graph);
    graph.getAllEdges = (workspaceId, options) => {
      calls.allEdges.push({ workspaceId, options });
      return realAllEdges(workspaceId, options);
    };
    graph.getEdges = (nodeId, workspaceId, options) => {
      calls.edges.push({ nodeId, workspaceId, options });
      return realGetEdges(nodeId, workspaceId, options);
    };

    const before = JSON.stringify(realAllEdges(WS));
    const entropy = kernel.entropy(WS);
    const gaps = kernel.detectGaps(WS);
    const after = JSON.stringify(realAllEdges(WS));

    // One frozen workspace read per call, and the per-node scan is gone.
    assert.deepEqual(calls.allEdges, [
      { workspaceId: WS, options: { clone: false } },
      { workspaceId: WS, options: { clone: false } },
    ]);
    assert.deepEqual(calls.edges, []);

    // Observable results are unchanged, and only scalars/ids leave the graph --
    // no raw edge or node record is handed back.
    assert.equal(entropy, -((0.25 / 1) * Math.log(0.25 / 1)) - ((0.75 / 1) * Math.log(0.75 / 1)));
    assert.deepEqual(gaps, ['b', 'c']);
    assert.ok(gaps.every(gap => typeof gap === 'string'));

    // The frozen views are read-only and nothing here mutates the graph.
    assert.equal(before, after, 'the read must not change the stored edges');
  } finally {
    closeKernel(kernel);
  }
});

test('reason reads the chain and cycle walks through frozen views', () => {
  // #3012: reason() walks forward/backward chains and searches for a cycle,
  // deep-cloning every visited edge along the way. The walk only reads
  // to/from/relation and reason copies every field it returns, so it now opts
  // into the frozen views. Pin that contract: every edge read the walk makes is
  // clone:false, the answers are unchanged, and no frozen record leaks out.
  const kernel = makeKernel('reason-frozen');

  try {
    const WS = 'workspace-a';
    for (const id of ['dog', 'animal', 'friend']) {
      kernel.graph.addNode(id, id, null, { workspaceId: WS });
    }
    kernel.graph.addEdge('dog', 'animal', 'is_a', {
      weight: 0.9, workspaceId: WS,
      provenance: { source: 'test', nested: { deep: true } },
      meta: { note: 'a', info: { deep: 'x' } },
    });
    kernel.graph.addEdge('dog', 'friend', 'related', {
      weight: 0.5, workspaceId: WS,
      provenance: { source: 'test', nested: { deep: true } },
      meta: { note: 'b', info: { deep: 'y' } },
    });

    const graph = kernel.graph;
    const edgeReads = [];
    for (const method of ['getEdges', 'getInEdges']) {
      const real = graph[method].bind(graph);
      graph[method] = (nodeId, workspaceId, options) => {
        edgeReads.push({ method, nodeId, options });
        return real(nodeId, workspaceId, options);
      };
    }

    const before = JSON.stringify(graph.getAllEdges(WS));
    const reason = kernel.reason('dog', WS);
    const after = JSON.stringify(graph.getAllEdges(WS));

    // The walk ran and every read it made opted out of the deep clone.
    assert.ok(edgeReads.length > 0, 'reason must walk the graph');
    assert.ok(
      edgeReads.every(read => read.options && read.options.clone === false),
      `every walk read must be clone:false, got ${JSON.stringify(edgeReads.slice(0, 3))}`,
    );

    // Observable answers are unchanged.
    assert.deepEqual(reason.data.forward.map(edge => [edge.from, edge.to, edge.relation]), [
      ['dog', 'animal', 'is_a'],
      ['dog', 'friend', 'related'],
    ]);

    // Only fresh, mutable objects leave reason -- a frozen view never escapes.
    const returned = [...reason.data.forward, ...reason.data.backward];
    assert.ok(returned.length > 0);
    assert.ok(returned.every(edge => !Object.isFrozen(edge)));
    assert.ok(reason.evidence.every(item => !Object.isFrozen(item)));

    assert.equal(before, after, 'the read must not change the stored edges');
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve reason and compare observable results', () => {
  const kernel = makeKernel('reason-compare');

  try {
    kernel.graph.addNode('dog', 'dog', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('cat', 'cat', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('animal', 'animal', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('friend', 'friend', null, { workspaceId: 'workspace-a' });
    kernel.graph.addEdge('dog', 'animal', 'is_a', { weight: 0.9, workspaceId: 'workspace-a' });
    kernel.graph.addEdge('cat', 'animal', 'is_a', { weight: 0.8, workspaceId: 'workspace-a' });
    kernel.graph.addEdge('dog', 'friend', 'related', { weight: 0.5, workspaceId: 'workspace-a' });

    const reason = kernel.reason('dog', 'workspace-a');
    assert.equal(reason.type, 'reason');
    assert.equal(reason.data.subject, 'dog');
    assert.match(reason.data.answer, /dog:/);
    assert.deepEqual(reason.data.forward.map(edge => [edge.from, edge.to, edge.relation]), [
      ['dog', 'animal', 'is_a'],
      ['dog', 'friend', 'related'],
    ]);
    assert.ok(Array.isArray(reason.data.backward));
    assert.ok(Array.isArray(reason.data.cycles));
    assert.ok(reason.evidence.length >= 2);

    const compare = kernel.compare('dog', 'cat', 'workspace-a');
    assert.equal(compare.type, 'compare');
    assert.equal(compare.data.a, 'dog');
    assert.equal(compare.data.b, 'cat');
    assert.deepEqual(compare.data.common.map(edge => [edge.to, edge.relation]), [
      ['animal', 'is_a'],
    ]);
    assert.deepEqual(compare.data.onlyA.map(edge => [edge.to, edge.relation]), [
      ['friend', 'related'],
    ]);
    assert.deepEqual(compare.data.onlyB, []);
    assert.ok(compare.evidence.length >= 2);

    // `unknown` is part of the observable shape now. `ask` has always reported
    // it; reason and compare answered "Bilmiyorum" with no structural signal at
    // all, which forced every consumer to match that Turkish display string to
    // find out whether there was an answer — a string doing load-bearing work
    // in control flow, one translation away from failing silently.
    const unknown = kernel.compare('dog', 'missing', 'workspace-a');
    assert.deepEqual(unknown.data, {
      a: 'dog',
      b: 'missing',
      answer: 'Bilmiyorum',
      unknown: true,
      common: [],
      onlyA: [],
      onlyB: [],
      paths: [],
    });
    assert.equal(compare.data.unknown, false, 'an answered compare says so structurally');
    assert.equal(reason.data.unknown, false, 'an answered reason says so structurally');
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve ask observable results', () => {
  const kernel = makeKernel('ask');

  try {
    kernel.graph.addNode('dog', 'dog', null, { workspaceId: 'default' });
    kernel.graph.addNode('mammal', 'mammal', null, { workspaceId: 'default' });
    kernel.graph.addNode('animal', 'animal', null, { workspaceId: 'default' });
    kernel.graph.addNode('friend', 'friend', null, { workspaceId: 'default' });
    kernel.graph.addEdge('dog', 'mammal', 'tür', { weight: 0.9, workspaceId: 'default' });
    kernel.graph.addEdge('mammal', 'animal', 'tür', { weight: 0.8, workspaceId: 'default' });
    kernel.graph.addEdge('dog', 'friend', 'yapabilir', { weight: 0.5, workspaceId: 'default' });

    const answer = kernel.ask('dog nedir');
    assert.equal(answer.type, 'ask');
    assert.equal(answer.data.subject, 'dog');
    assert.equal(answer.data.unknown, false);
    assert.match(answer.data.answer, /dog/);
    assert.match(answer.data.answer, /mammal/);
    assert.match(answer.data.answer, /animal/);
    assert.match(answer.data.answer, /friend/);
    assert.ok(answer.evidence.length >= 2);

    const unknown = kernel.ask('missing nedir');
    // The fallback identity subject. This graph has neither identity node, so
    // the canonical name is reported; test/identity-subject-fallback.test.js
    // covers the legacy-graph read.
    assert.deepEqual(unknown.data, {
      answer: 'Bilmiyorum',
      subject: 'huqan',
      unknown: true,
      // The unanswered return reports the zero alternatives its afterAsk
      // event already announced, as ASK_DATA_SCHEMA requires (#3483).
      alternatives: 0,
    });

    const why = kernel.ask('neden dog');
    assert.equal(why.type, 'reason');
    assert.equal(why.data.subject, 'dog');
  } finally {
    closeKernel(kernel);
  }
});
