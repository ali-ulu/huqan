'use strict';

// #2138 moved KernelV2's forwarders and its evidence/explanation helpers into
// modules installed on the prototype. These pin that the move is invisible:
// the methods are ordinary non-enumerable prototype methods, and the verify
// explanation reads exactly as it did.

const test = require('node:test');
const assert = require('node:assert/strict');

const KernelV2 = require('../kernel.v2');

const INSTALLED = ['selfLearn', 'reload', 'hasCapability', 'getStats', 'reasonSandbox',
  '_inferTypeChain', '_buildVerifyExplanation', '_withVerifyDetails', 'collectFactTargets', 'buildDirectTypeEvidence'];

test('installed methods are own, non-enumerable, writable prototype methods like class methods', () => {
  const classMethod = Object.getOwnPropertyDescriptor(KernelV2.prototype, 'verify');
  for (const name of INSTALLED) {
    const descriptor = Object.getOwnPropertyDescriptor(KernelV2.prototype, name);
    assert.ok(descriptor, name);
    assert.equal(typeof descriptor.value, 'function', name);
    for (const key of ['enumerable', 'writable', 'configurable']) {
      assert.equal(descriptor[key], classMethod[key], `${name}.${key}`);
    }
  }
});

test('the verify explanation keeps its exact wording for each status', () => {
  const explain = KernelV2.prototype._buildVerifyExplanation;
  assert.equal(explain({ status: 'verified' }), 'The statement is directly supported by the graph.');
  assert.equal(explain({ status: 'verified', inferred: true }), 'The statement is supported by an inference chain in the graph.');
  assert.equal(explain({ status: 'contradicted', contradictionReason: 'type' }), 'The statement was found contradictory (type).');
  assert.equal(explain({ status: 'unknown' }, ['a -> b']), 'Not enough evidence was found for the statement. Evidence summary: a -> b.');
  assert.equal(
    explain({ status: 'verified', reasoningPath: [{ from: 'a', relation: 'is', to: 'b' }] }, [], { manipulation: true, labels: [] }),
    'The statement is directly supported by the graph. Path followed: a -> is -> b. Risk markers: manipulation.',
  );
});
