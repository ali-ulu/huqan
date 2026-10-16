const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateScopeQuestion, isInScope, SCOPE_THRESHOLD_DEFAULT, DECISION } = require('./laya-risk');

test('laya-risk: high noul (P(true)) -> in scope -> ALLOW (polarity fix)', () => {
  const result = evaluateScopeQuestion({ noul: 0.9 }, { threshold: 0.5 });
  assert.equal(result.ok, true);
  assert.equal(result.inScope, true);
  assert.equal(result.outOfScope, false);
  assert.equal(result.decision, DECISION.ALLOW);
  assert.equal(result.noul, 0.9);
  assert.equal(result.threshold, 0.5);
  assert.equal(result.boundary, false);
});

test('laya-risk: low noul (P(true)) -> out of scope -> REVIEW', () => {
  const result = evaluateScopeQuestion({ noul: 0.2 }, { threshold: 0.5 });
  assert.equal(result.inScope, false);
  assert.equal(result.outOfScope, true);
  assert.equal(result.decision, DECISION.REVIEW);
  assert.equal(result.noul, 0.2);
});

test('laya-risk: exact threshold -> in scope (boundary) -> ALLOW', () => {
  const result = evaluateScopeQuestion({ noul: 0.5 }, { threshold: 0.5 });
  assert.equal(result.inScope, true);
  assert.equal(result.boundary, true);
  assert.equal(result.decision, DECISION.ALLOW);
});

test('laya-risk: noul below custom threshold -> REVIEW', () => {
  const result = evaluateScopeQuestion({ noul: 0.8 }, { threshold: 0.9 });
  assert.equal(result.inScope, false);
  assert.equal(result.decision, DECISION.REVIEW);
});

test('laya-risk: noul is P(true), not P(false) — high value is allowed, not reviewed', () => {
  const high = evaluateScopeQuestion({ noul: 0.99 }, { threshold: 0.5 });
  const low = evaluateScopeQuestion({ noul: 0.01 }, { threshold: 0.5 });
  assert.equal(high.decision, DECISION.ALLOW);
  assert.equal(low.decision, DECISION.REVIEW);
});

test('laya-risk: missing/invalid noul falls back to default threshold boundary -> ALLOW', () => {
  const missing = evaluateScopeQuestion({}, { threshold: 0.5 });
  assert.equal(missing.noul, 0.5);
  assert.equal(missing.inScope, true);
  assert.equal(missing.decision, DECISION.ALLOW);

  const invalid = evaluateScopeQuestion({ noul: 'not-a-number' }, { threshold: 0.5 });
  assert.equal(invalid.noul, 0.5);
  assert.equal(invalid.inScope, true);
});

test('laya-risk: isInScope helper', () => {
  assert.equal(isInScope(0.9, 0.5), true);
  assert.equal(isInScope(0.2, 0.5), false);
  assert.equal(isInScope(0.5, 0.5), true);
  assert.equal(isInScope(0.5), true); // default threshold 0.5
  assert.equal(isInScope(0.49), false);
});

test('laya-risk: default threshold constant', () => {
  assert.equal(SCOPE_THRESHOLD_DEFAULT, 0.5);
});
