const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runContextSimilarity } = require('../lib/kernel-context-similarity');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8').replace(/\r\n/g, '\n');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-context-similarity.js'), 'utf8').replace(/\r\n/g, '\n');

test('Kernel.contextSimilarity is a one-line, cycle-free delegation', () => {
  assert.match(
    kernelSource,
    /contextSimilarity\(a, b, context\) \{\n    return runContextSimilarity\(this\.graph, a, b, context\);\n  \}/,
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*kernel/);
  assert.doesNotMatch(delegateSource, /this\._(db|stmts|nodes|edges)/);
  assert.deepEqual(Object.keys(require('../lib/kernel-context-similarity')), ['runContextSimilarity']);
});

test('contextSimilarity applies context weights and preserves the cosine calculation', () => {
  const vectors = {
    context: { x: 2, y: 4 },
    a: { x: 1, y: 1 },
    b: { x: 1, y: 0 },
  };
  const before = JSON.parse(JSON.stringify(vectors));
  const graph = { getNode(id) { return vectors[id] ? { vector: vectors[id] } : null; } };

  const result = runContextSimilarity(graph, 'a', 'b', 'context');

  assert.ok(Math.abs(result - (4 / (2 * Math.sqrt(20)))) < 1e-12);
  assert.deepEqual(vectors, before);
});

test('contextSimilarity returns zero for missing nodes and zero-magnitude vectors', () => {
  const graph = {
    getNode(id) {
      if (id === 'zero-a') return { vector: { x: 0, y: 0 } };
      if (id === 'zero-b') return { vector: { x: 0, y: 0 } };
      return null;
    },
  };

  assert.strictEqual(runContextSimilarity(graph, 'missing', 'zero-b', 'context'), 0);
  assert.strictEqual(runContextSimilarity(graph, 'zero-a', 'zero-b', 'context'), 0);
});

test('contextSimilarity uses the union of vector dimensions and neutral context defaults', () => {
  const graph = {
    getNode(id) {
      return {
        vector: {
          a: { x: 1 }[id] ?? 0,
          b: { y: 1 }[id] ?? 0,
          context: { x: 0, y: 0 }[id] ?? 0,
        },
      };
    },
  };

  assert.strictEqual(runContextSimilarity(graph, 'a', 'b', 'context'), 0);
});
