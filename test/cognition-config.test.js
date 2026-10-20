'use strict';

// COG Faz 0 PR-0b (#4061): strict resolver for the single opts.cognition namespace (S3).
const test = require('node:test');
const assert = require('node:assert/strict');
const { COGNITION_FLAGS, FLAG_REQUIRES, resolveCognitionConfig } = require('../lib/cognition/cognition-config');
const { COGNITION_STATUS, AUTHORITY } = require('../lib/cognition/contract');

const ALL_OFF = Object.fromEntries(COGNITION_FLAGS.map((f) => [f, false]));
const ALL_ON = Object.fromEntries(COGNITION_FLAGS.map((f) => [f, true]));

test('declares exactly the nine namespace flags from the plan', () => {
  assert.deepEqual([...COGNITION_FLAGS].sort(), [
    'curiosity', 'dualProcess', 'percept', 'predictionError', 'reward',
    'salience', 'value', 'workingMemory', 'workspace',
  ]);
  assert.ok(Object.isFrozen(COGNITION_FLAGS));
});

test('every dependency edge points at a declared flag', () => {
  for (const [flag, deps] of Object.entries(FLAG_REQUIRES)) {
    assert.ok(COGNITION_FLAGS.includes(flag));
    for (const dep of deps) assert.ok(COGNITION_FLAGS.includes(dep), `${flag} -> ${dep}`);
  }
});

test('absent namespace resolves to every flag off', () => {
  for (const input of [undefined, null, {}]) {
    const r = resolveCognitionConfig(input);
    assert.equal(r.status, COGNITION_STATUS.MEASURED);
    assert.equal(r.authority, AUTHORITY.SIGNAL_ONLY);
    assert.deepEqual(r.flags, ALL_OFF);
    assert.equal(r.anyEnabled, false);
  }
});

test('resolveCognitionConfig rejects unknown keys', () => {
  const r = resolveCognitionConfig({ predictionError: true, telepathy: true });
  assert.equal(r.status, COGNITION_STATUS.REJECT);
  assert.deepEqual(r.flags, ALL_OFF);
  assert.match(r.reasons.join(' '), /unknown_flag:telepathy/);
});

test('rejects non-boolean flag values instead of coercing them', () => {
  for (const bad of ['true', 1, 0, null, {}, []]) {
    const r = resolveCognitionConfig({ predictionError: bad });
    assert.equal(r.status, COGNITION_STATUS.REJECT, String(bad));
    assert.match(r.reasons.join(' '), /invalid_type:predictionError/);
    assert.deepEqual(r.flags, ALL_OFF);
  }
});

test('rejects a namespace that is not a plain object', () => {
  for (const bad of ['on', 1, true, [], [true]]) {
    const r = resolveCognitionConfig(bad);
    assert.equal(r.status, COGNITION_STATUS.REJECT);
    assert.match(r.reasons.join(' '), /invalid_namespace/);
  }
});

test('rejects impossible combinations: reward without predictionError', () => {
  const r = resolveCognitionConfig({ reward: true });
  assert.equal(r.status, COGNITION_STATUS.REJECT);
  assert.match(r.reasons.join(' '), /missing_dependency:reward->predictionError/);
  assert.deepEqual(r.flags, ALL_OFF);
});

test('rejects value without reward and workspace without workingMemory', () => {
  assert.match(resolveCognitionConfig({ predictionError: true, value: true }).reasons.join(' '), /missing_dependency:value->reward/);
  assert.match(resolveCognitionConfig({ workspace: true }).reasons.join(' '), /missing_dependency:workspace->workingMemory/);
});

test('an explicit false dependency is also missing', () => {
  const r = resolveCognitionConfig({ predictionError: false, reward: true });
  assert.equal(r.status, COGNITION_STATUS.REJECT);
});

test('accepts a satisfied chain and the full set', () => {
  const chain = resolveCognitionConfig({ predictionError: true, reward: true, value: true });
  assert.equal(chain.status, COGNITION_STATUS.MEASURED);
  assert.deepEqual(chain.flags, { ...ALL_OFF, predictionError: true, reward: true, value: true });
  assert.equal(chain.anyEnabled, true);
  const all = resolveCognitionConfig(ALL_ON);
  assert.equal(all.status, COGNITION_STATUS.MEASURED);
  assert.deepEqual(all.flags, ALL_ON);
});

test('rejection reports every problem and never leaves a flag on', () => {
  const r = resolveCognitionConfig({ reward: true, x: 1, value: 'y' });
  assert.equal(r.status, COGNITION_STATUS.REJECT);
  assert.ok(r.reasons.length >= 3);
  assert.deepEqual(r.flags, ALL_OFF);
  assert.equal(r.anyEnabled, false);
});

test('result is deeply frozen and the input is not mutated', () => {
  const input = Object.freeze({ predictionError: true });
  const r = resolveCognitionConfig(input);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.flags) && Object.isFrozen(r.reasons));
  assert.deepEqual(input, { predictionError: true });
  assert.notEqual(resolveCognitionConfig({}).flags, resolveCognitionConfig({}).flags);
});

test('ignores inherited and prototype-polluting keys as unknown', () => {
  const polluted = JSON.parse('{"__proto__": {"predictionError": true}}');
  const r = resolveCognitionConfig(polluted);
  assert.equal(r.status, COGNITION_STATUS.REJECT);
  assert.deepEqual(r.flags, ALL_OFF);
});
