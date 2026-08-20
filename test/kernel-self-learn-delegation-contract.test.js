'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runSelfLearn } = require('../lib/kernel-self-learn');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-self-learn.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Kernel`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('KERNEL: selfLearn is a one-line delegate', () => {
  assert.equal(
    methodBody(kernelSource, 'selfLearn'),
    'return runSelfLearn(() => this.detectGaps(), this.graph);',
  );
});

test('KERNEL: selfLearn delegate is narrow, public-API-only, and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /kernel\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/kernel["']\)/);
  assert.doesNotMatch(delegateSource, /_edges|_nodes|_db|_stmts/);
  assert.match(delegateSource, /graph\.edgeCount\(\)/);
  assert.match(delegateSource, /graph\.getEdges\(gapId\)/);
  assert.match(delegateSource, /graph\.getInEdges\(gapId\)/);
});

test('KERNEL: selfLearn preserves edgeCount delta and skips connected gaps', () => {
  const calls = [];
  const counts = [10, 12];
  const graph = {
    edgeCount: (...args) => {
      calls.push(['edgeCount', args]);
      return counts.shift();
    },
    getNode: (id) => ({ id }),
    getEdges: (id) => {
      calls.push(['getEdges', id]);
      return id === 'connected' ? [{ id: 'edge' }] : [];
    },
    getInEdges: (id) => {
      calls.push(['getInEdges', id]);
      return [];
    },
    cosineSimilarity: (from, to) => {
      calls.push(['cosineSimilarity', from, to]);
      return 0;
    },
  };

  assert.deepEqual(runSelfLearn(() => ['connected', 'isolated'], graph), { gaps: 2, learned: 2 });
  assert.deepEqual(calls.filter(([name]) => name === 'edgeCount'), [
    ['edgeCount', []],
    ['edgeCount', []],
  ]);
  assert.deepEqual(calls.filter(([name]) => name === 'cosineSimilarity'), [
    ['cosineSimilarity', 'isolated', 'isolated'],
  ]);
});

test('KERNEL: selfLearn preserves empty-gap early return without counting edges', () => {
  let edgeCountCalled = false;
  const graph = {
    edgeCount: () => {
      edgeCountCalled = true;
      throw new Error('edgeCount must not run for an empty gap set');
    },
  };

  assert.deepEqual(runSelfLearn(() => [], graph), { gaps: 0, learned: 0, message: 'Bo?luk yok' });
  assert.equal(edgeCountCalled, false);
});
