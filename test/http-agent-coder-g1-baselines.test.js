'use strict';

// #4065 G1 baseline for http-agent-coder-g1-feedback.test.js: with the same
// history and queue, a confirmed outcome keeps the input-order choice (the
// other kind of work). The cognition-off and observation-cut arms live in their
// own files (-off, -mutation) so each stays inside the 90 s per-file budget.

const assert = require('node:assert/strict');
const test = require('node:test');
const { g1Arm } = require('./helpers/http-coder-fixture');

test('a confirmed outcome keeps the original next choice', async t => {
  const { steps, trail } = await g1Arm(t, { failing: false });
  assert.ok(trail.some(row => row.reason === 'native_acceptance_observed' && row.outcome === 'confirmed'));
  assert.equal(steps[1].id, 'coder:alt');
});
