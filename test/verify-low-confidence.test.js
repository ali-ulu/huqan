'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function verifyWithWeight(weight) {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
  kernel.graph.addNode('a', 'a');
  kernel.graph.addNode('b', 'b');
  kernel.graph.addEdge('a', 'b', 'tür', { weight });
  return kernel.verify('a is b', { skipDecomposition: true }).data;
}

test('weak supporting edges do not become contradictions and retain their ordering (#1173)', () => {
  const weak = verifyWithWeight(0.2);
  const strong = verifyWithWeight(0.9);

  assert.equal(weak.status, 'unknown');
  assert.equal(strong.status, 'verified');
  assert.ok(weak.confidence < strong.confidence, `${weak.confidence} should be below ${strong.confidence}`);
});
