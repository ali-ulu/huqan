const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runAlternatives } = require('../lib/kernel-alternatives');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8').replace(/\r\n/g, '\n');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-alternatives.js'), 'utf8').replace(/\r\n/g, '\n');

test('Kernel.alternatives is a one-line, cycle-free delegation', () => {
  assert.match(
    kernelSource,
    /alternatives\(subject, maxPaths = 3, workspaceId = 'default'\) \{\n    return runAlternatives\(value => this\.normalizeWord\(value\), this\.graph, \(type, data, evidence\) => this\._ok\(type, data, evidence\), subject, maxPaths, workspaceId\);\n  \}/,
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*kernel/);
  assert.doesNotMatch(delegateSource, /this\._(db|stmts|nodes|edges)/);
  assert.deepEqual(Object.keys(require('../lib/kernel-alternatives')), ['runAlternatives']);
});

test('alternatives returns the existing missing-node envelope through the injected ok callback', () => {
  const calls = [];
  const graph = {
    getNode() { return null; },
    getEdges() { throw new Error('getEdges must not run for a missing node'); },
  };
  const result = runAlternatives(
    value => value.trim().toLowerCase(),
    graph,
    (...args) => {
      calls.push(args);
      return { type: args[0], data: args[1], evidence: args[2] };
    },
    ' Unknown ',
  );

  assert.deepEqual(result, {
    type: 'alternatives',
    data: { subject: 'unknown', answer: 'Bilmiyorum', paths: [] },
    evidence: [],
  });
  assert.deepEqual(calls, [['alternatives', { subject: 'unknown', answer: 'Bilmiyorum', paths: [] }, []]]);
});

test('alternatives preserves relation priority, highest weight selection, chains, maxPaths, and evidence', () => {
  const calls = [];
  const edgeMap = {
    subject: [
      { to: 'type-low', relation: 'tür', weight: 0.4 },
      { to: 'type-high', relation: 'tür', weight: 0.9 },
      { to: 'can-do', relation: 'yapabilir', weight: 0.7 },
      { to: 'similar', relation: 'benzer', weight: 0.8 },
    ],
    'type-high': [
      { to: 'chain-type', relation: 'özellik' },
      { to: 'subject', relation: 'benzer' },
    ],
    'can-do': [
      { to: 'chain-capability', relation: 'özellik' },
    ],
  };
  const graph = {
    getNode(id) { return id === 'subject' ? { id } : null; },
    getEdges(id) { return edgeMap[id] || []; },
  };
  const result = runAlternatives(
    value => value.trim().toLowerCase(),
    graph,
    (...args) => {
      calls.push(args);
      return { type: args[0], data: args[1], evidence: args[2] };
    },
    ' Subject ',
    2,
  );

  assert.equal(calls.length, 1);
  assert.equal(result.type, 'alternatives');
  assert.deepEqual(result.data.paths, [
    {
      type: 'tür',
      from: 'subject',
      to: 'type-high',
      chain: [{ node: 'chain-type', rel: 'özellik' }],
      confidence: 0.9,
    },
    {
      type: 'yapabilir',
      from: 'subject',
      to: 'can-do',
      chain: [{ node: 'chain-capability', rel: 'özellik' }],
      confidence: 0.7,
    },
  ]);
  assert.equal(
    result.data.answer,
    'subject: alternative paths:\n'
      + '  [tür] subject → type-high → chain-type(özellik) (confidence: 0.90)\n'
      + '  [yapabilir] subject → can-do → chain-capability(özellik) (confidence: 0.70)\n',
  );
  assert.deepEqual(result.evidence, [
    {
      kind: 'alternative_path',
      text: 'subject --[tür]--> type-high',
      confidence: 0.9,
      nodes: ['subject', 'type-high'],
      edges: [{ from: 'subject', to: 'type-high', relation: 'tür' }],
    },
    {
      kind: 'alternative_path',
      text: 'subject --[yapabilir]--> can-do',
      confidence: 0.7,
      nodes: ['subject', 'can-do'],
      edges: [{ from: 'subject', to: 'can-do', relation: 'yapabilir' }],
    },
  ]);
});

test('alternatives does not mutate Graph read results and returns Bilmiyorum when no usable path exists', () => {
  const edges = [{ to: 'self', relation: 'unrelated', weight: 0.9 }];
  const graph = {
    getNode() { return { id: 'subject' }; },
    getEdges() { return edges; },
  };
  const result = runAlternatives(
    value => value,
    graph,
    (type, data, evidence) => ({ type, data, evidence }),
    'subject',
  );

  assert.deepEqual(result.data, { subject: 'subject', answer: 'Bilmiyorum', paths: [] });
  assert.deepEqual(edges, [{ to: 'self', relation: 'unrelated', weight: 0.9 }]);
});
