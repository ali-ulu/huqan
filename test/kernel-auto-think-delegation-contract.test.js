const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runAutoThinkTick } = require('../lib/kernel-auto-think');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-auto-think.js'), 'utf8');

test('Kernel._autoThinkTick is a one-line, cycle-free delegation', () => {
  assert.match(
    kernelSource,
    /_autoThinkTick\(\) \{\n    return runAutoThinkTick\(\{ dreamer: this\._dreamer, graph: this\.graph, commitBackgroundEdge: \(\.\.\.args\) => this\._commitBackgroundEdge\(\.\.\.args\), introspect: \(\.\.\.args\) => this\.introspect\(\.\.\.args\), autoThinkLog: \(\.\.\.args\) => this\._autoThinkLog\(\.\.\.args\), getDreamCount: \(\) => this\._dreamCount, setDreamCount: value => \{ this\._dreamCount = value; \} \}\);\n  \}/,
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*kernel/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /\._(nodes|edges|db|stmts)/);
  assert.deepEqual(Object.keys(require('../lib/kernel-auto-think')), ['runAutoThinkTick']);
});

test('auto-think routes eligible hypotheses through the background-edge seam', () => {
  const calls = [];
  let dreamCount;
  let nodeCountCalls = 0;
  const graph = {
    hasAnyEdge: () => false,
    getNode: id => ({ id }),
    nodeCount: () => {
      nodeCountCalls += 1;
      return 42;
    },
  };
  const inputHypotheses = [
    { from: 'a', to: 'b', confidence: 1, type: 'benzerlik' },
    { from: 'c', to: 'd', confidence: 0.2, type: 'zincir' },
  ];
  const snapshot = JSON.parse(JSON.stringify(inputHypotheses));
  const logs = [];

  runAutoThinkTick({
    dreamer: { dream: () => inputHypotheses },
    graph,
    commitBackgroundEdge: (...args) => {
      calls.push(args);
      return { decision: 'allow', edge: { id: 'edge-1' } };
    },
    introspect: () => ({ data: { saglik: { celiski: 0, metaGuven: 1 }, zayifNoktalar: [] } }),
    autoThinkLog: message => logs.push(message),
    getDreamCount: () => dreamCount,
    setDreamCount: value => { dreamCount = value; },
  });

  assert.equal(dreamCount, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    'a',
    'b',
    'benzer',
    '_autoThinkTick',
    { provenanceExtra: { hypothesisType: 'benzerlik', hypothesisConfidence: 1 } },
  ]);
  assert.equal(nodeCountCalls, 1);
  assert.deepEqual(inputHypotheses, snapshot);
  assert.deepEqual(logs, ['1 new connections - 42 nodes total']);
});

test('auto-think preserves introspection cadence and empty-dream logging cadence', () => {
  let dreamCount = 2;
  let introspectCalls = 0;
  const logs = [];
  const graph = { hasAnyEdge: () => true, getNode: () => ({ id: 'present' }), nodeCount: () => 0 };
  const introspection = { data: { saglik: { celiski: 6, metaGuven: 0.25 }, zayifNoktalar: ['gap'] } };

  for (let index = 0; index < 3; index += 1) {
    runAutoThinkTick({
      dreamer: { dream: () => [] },
      graph,
      commitBackgroundEdge: () => { throw new Error('no edge should be committed'); },
      introspect: () => {
        introspectCalls += 1;
        return introspection;
      },
      autoThinkLog: message => logs.push(message),
      getDreamCount: () => dreamCount,
      setDreamCount: value => { dreamCount = value; },
    });
  }

  assert.equal(dreamCount, 5);
  assert.equal(introspectCalls, 1);
  assert.deepEqual(logs, ['gap', 'empty dream, more input needed']);
});
