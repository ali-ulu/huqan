'use strict';

// #4065 G1 baseline: with cognition off, the same failure leaves the order as
// the plan built it.

const assert = require('node:assert/strict');
const test = require('node:test');
const { g1Arm } = require('./helpers/http-coder-fixture');

test('without cognition the same failure leaves the order unchanged', async t => {
  const { steps, trail } = await g1Arm(t, { failing: true, cognition: false });
  assert.deepEqual(trail, []);
  assert.equal(steps[1].id, 'coder:alt');
});
