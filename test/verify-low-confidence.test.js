'use strict';
const { isolatedKernelOptions, isolatedGraphOptions } = require('./helpers/isolated-persistence');

const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function verifyWithWeight(weight) {
  const kernel = new Kernel(isolatedKernelOptions('verify-low-confidence', { noLoad: true, useSQLite: false, loadPlugins: false }));
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

test('a fact that only reached the graph through learn is verified as taught_only (#3652)', () => {
  const kernel = new Kernel(isolatedKernelOptions('verify-grounding-taught', { noLoad: true, useSQLite: false, loadPlugins: false }));
  kernel.learn('the earth is flat', { workspaceId: 'default', ...Kernel.createAdmissionBypassOpts('test_fixture_seed') });
  const data = kernel.verify('the earth is flat').data;
  assert.equal(data.status, 'verified');
  assert.equal(data.grounding, 'taught_only');
});

test('a path made only of learned edges is taught_only too (#3652)', () => {
  const kernel = new Kernel(isolatedKernelOptions('verify-grounding-path', { noLoad: true, useSQLite: false, loadPlugins: false }));
  for (const id of ['a', 'b', 'c']) kernel.graph.addNode(id, id);
  kernel.graph.addEdge('a', 'b', 'tür', { weight: 0.9, source: 'learn' });
  kernel.graph.addEdge('b', 'c', 'tür', { weight: 0.9, source: 'learn' });
  const data = kernel.verify('a is c', { skipDecomposition: true }).data;
  assert.equal(data.status, 'verified');
  assert.equal(data.grounding, 'taught_only');
});

test('an edge written outside learn is reported as stored_graph (#3652)', () => {
  const data = verifyWithWeight(0.9);
  assert.equal(data.status, 'verified');
  assert.equal(data.grounding, 'stored_graph');
});

test('a claim the graph does not support carries no grounding (#3652)', () => {
  const data = verifyWithWeight(0.2);
  assert.equal(data.status, 'unknown');
  assert.equal(data.grounding, undefined);
});
