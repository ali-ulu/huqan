'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { COGNITION_STATUS, AUTHORITY, clamp01, round6, freezeResult } = require('../lib/cognition/contract');

test('status and authority vocabularies match the program contract', () => {
  assert.deepEqual(Object.keys(COGNITION_STATUS).sort(), ['ABSTAIN', 'INSUFFICIENT', 'MEASURED', 'REJECT']);
  assert.deepEqual(Object.values(AUTHORITY).sort(),
    ['CANDIDATE_ONLY', 'OBSERVATION_ONLY', 'PROPOSAL_ONLY', 'ROUTING_ADVICE_ONLY', 'SIGNAL_ONLY']);
  assert.ok(Object.isFrozen(COGNITION_STATUS) && Object.isFrozen(AUTHORITY));
});

test('clamp01 bounds finite values and maps non-finite input to 0', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.25), 0.25);
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(Infinity), 0);
  assert.equal(clamp01('0.5'), 0);
});

test('round6 rounds to six decimals and maps non-finite input to null', () => {
  assert.equal(round6(1 / 3), 0.333333);
  assert.equal(round6(NaN), null);
  assert.equal(round6(undefined), null);
});

test('freezeResult deep-freezes without mutating the input', () => {
  const input = { a: { b: [1, { c: 2 }] } };
  const out = freezeResult(input);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.a) && Object.isFrozen(out.a.b) && Object.isFrozen(out.a.b[1]));
  assert.ok(!Object.isFrozen(input));
  assert.deepEqual(out, input);
});
