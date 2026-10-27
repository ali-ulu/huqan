'use strict';

// #4065 G1 mutation: the same failure with the outcome observation cut leaves
// the next choice where the baselines put it, so the feedback test cannot pass
// without the observation-to-next-choice link.

const assert = require('node:assert/strict');
const test = require('node:test');
const { g1Arm } = require('./helpers/http-coder-fixture');

test('cutting the outcome observation removes the feedback (G1 mutation)', async t => {
  const { steps, trail } = await g1Arm(t, { failing: true, observe: false });
  assert.ok(!trail.some(row => row.reason === 'native_acceptance_observed'));
  assert.equal(steps[1].id, 'coder:alt');
});
