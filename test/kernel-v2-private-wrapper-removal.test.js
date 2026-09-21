'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const KernelV2 = require('../kernel.v2');

test('KernelV2 does not proxy wrapped Kernel private admission/audit seams', () => {
  const privatePassThroughs = [
    '_commitBackgroundEdge',
    '_evaluateLearnAdmission',
    '_backgroundProvenance',
    '_appendAuditEvent',
    '_admissionReceiptDetails',
  ];
  for (const name of privatePassThroughs) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(KernelV2.prototype, name),
      false,
      `${name} must not be a KernelV2 facade surface`,
    );
  }
});

test('KernelV2 keeps the public background-edge seam', () => {
  const kernel = new KernelV2({ noLoad: true, loadPlugins: false, useSQLite: false, memoryStoreUseSQLite: false });
  const expected = { decision: 'allow', edge: { from: 'a', to: 'b' } };
  const calls = [];
  kernel.kernel.commitBackgroundEdge = (...args) => {
    calls.push(args);
    return expected;
  };

  assert.strictEqual(
    kernel.commitBackgroundEdge('a', 'b', 'rel', 'test', { workspaceId: 'w' }),
    expected,
  );
  assert.deepEqual(calls, [['a', 'b', 'rel', 'test', { workspaceId: 'w' }]]);
  kernel.graph.close?.();
  kernel.memory.close?.();
});

test('KernelV2 candidate-claim ingestion remains an explicit public delegation', () => {
  const kernel = new KernelV2({ noLoad: true, loadPlugins: false, useSQLite: false, memoryStoreUseSQLite: false });
  const expected = { candidate: { candidateId: 'c1' } };
  const input = { claim: 'a rel b' };
  const opts = { workspaceId: 'w' };
  const calls = [];
  kernel.kernel.ingestCandidateClaim = (...args) => {
    calls.push(args);
    return expected;
  };

  assert.strictEqual(kernel.ingestCandidateClaim(input, opts), expected);
  assert.deepEqual(calls, [[input, opts]]);
  kernel.graph.close?.();
  kernel.memory.close?.();
});
