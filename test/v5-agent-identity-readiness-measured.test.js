'use strict';

/**
 * `implementationBoundaryClean` must be a measurement, not a constant.
 *
 * `notCompleted` was a shallow copy of a frozen all-false map that never read
 * `coverage`, so `notCompletedValues.every(v => v === false)` was true for
 * every possible input -- a readiness claim that could not fail. An auditor
 * reads that field as "the implementation boundary was checked and is clean",
 * and nothing had been checked.
 *
 * Worse, `nonEnforcement` described the same six capabilities from the same
 * coverage report with the opposite polarity, and the two disagreed: the
 * constant said "not un-completed" while the measurement said "not enforced".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentIdentityReadinessIndex } = require('../schemas/v5/agent-identity-readiness');

const CAPABILITIES = [
  ['runtimeEnforcement', 'runtimeIdentity'],
  ['connectorIdentityEnforcement', 'connectorIdentity'],
  ['a2aIdentityExchange', 'a2aIdentityExchange'],
  ['marketplaceIdentityLayer', 'marketplaceIdentity'],
  ['trustPackageWriterReader', 'trustPackageWriterReader'],
  ['agentActionPolicyEngine', 'agentActionPolicyEngine'],
];

test('the two views of the boundary agree, capability by capability', () => {
  const { boundaryMatrix } = buildAgentIdentityReadinessIndex();

  for (const [capability, enforcementKey] of CAPABILITIES) {
    assert.equal(
      boundaryMatrix.notCompleted[capability],
      boundaryMatrix.nonEnforcement[enforcementKey],
      `${capability} must not be reported one way by notCompleted and another by nonEnforcement`,
    );
  }
});

test('an unimplemented capability is reported as not completed', () => {
  const { boundaryMatrix } = buildAgentIdentityReadinessIndex();

  for (const [capability] of CAPABILITIES) {
    assert.equal(boundaryMatrix.notCompleted[capability], true, `${capability} is not implemented today`);
  }
});

test('the boundary is not called clean while capabilities are outstanding', () => {
  const index = buildAgentIdentityReadinessIndex();

  const outstanding = Object.values(index.boundaryMatrix.notCompleted).some((value) => value === true);
  assert.equal(outstanding, true, 'the fixture must have outstanding capabilities');
  assert.equal(index.implementationBoundaryClean, false);
});

test('implementationBoundaryClean is derived from notCompleted, not asserted', () => {
  const index = buildAgentIdentityReadinessIndex();

  assert.equal(
    index.implementationBoundaryClean,
    Object.values(index.boundaryMatrix.notCompleted).every((value) => value === false),
  );
});

test('the sibling claim still reads its own coverage', () => {
  const index = buildAgentIdentityReadinessIndex();

  assert.equal(
    index.agentIdentityChainComplete,
    Object.values(index.boundaryMatrix.completed).every((value) => value === true),
  );
});
