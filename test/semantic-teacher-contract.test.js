'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consensus, validateTeacherOutput, assertNoHoldoutLeakage } = require('../scripts/semantic-teacher-contract');
const input = { stored: { text: 'Kapı açık.' }, incoming: { text: 'Kapı kapalı.' } };
const distribution = { CONTRADICTION: 0.9, ENTAILMENT: 0, NEUTRAL: 0.1, ABSTAIN: 0 };
const teacher = (teacherId, probabilities = distribution) => ({ teacherId, teacherVersion: '1', input, distribution: probabilities, latencyMs: 0 });

test('consensus retains soft labels and is invariant to teacher order', () => {
  const outputs = [teacher('a'), teacher('b')];
  const result = consensus(outputs);
  assert.deepEqual(result, consensus([...outputs].reverse()));
  assert.equal(result.distribution.CONTRADICTION, 0.9);
  assert.equal(result.weight, 1);
  assert.equal(result.needsReview, false);
});
test('disagreement lowers training weight and requires human review', () => {
  const result = consensus([teacher('a'), teacher('b', { CONTRADICTION: 0, ENTAILMENT: 0, NEUTRAL: 1, ABSTAIN: 0 })]);
  assert.equal(result.weight, 0);
  assert.equal(result.needsReview, true);
});
test('invalid distributions, identities and mismatched pairs fail closed', () => {
  assert.throws(() => validateTeacherOutput(teacher('a', { ...distribution, NEUTRAL: NaN })), /teacher_distribution_invalid/);
  assert.throws(() => validateTeacherOutput(teacher('a', { ...distribution, NEUTRAL: 0.2 })), /teacher_distribution_invalid/);
  assert.throws(() => consensus([teacher('a'), teacher('a')]), /teacher_duplicate/);
  assert.throws(() => consensus([teacher('a')]), /teacher_quorum_missing/);
  assert.throws(() => consensus([teacher('a'), { ...teacher('b'), input: { ...input, incoming: { text: 'Başka iddia' } } }]), /teacher_pair_mismatch/);
});
test('holdout content cannot enter training under a renamed identifier or split', () => {
  const frozen = [{ ...input, pairId: 'holdout', split: 'holdout' }];
  assert.throws(() => assertNoHoldoutLeakage([{ ...input, pairId: 'renamed', split: 'train' }], frozen), /semantic_holdout_leakage/);
  assert.throws(() => assertNoHoldoutLeakage([{ stored: input.incoming, incoming: input.stored, split: 'train' }], frozen), /semantic_holdout_leakage/);
  assert.throws(() => assertNoHoldoutLeakage([{ stored: { text: 'Başka' }, incoming: { text: 'Yeni' }, pairGroupId: 'g' }],
    [{ ...input, split: 'holdout', pairGroupId: 'g' }]), /semantic_holdout_leakage/);
  assert.doesNotThrow(() => assertNoHoldoutLeakage([{ stored: { text: 'Yeni' }, incoming: { text: 'Örnek' }, split: 'train' }], frozen));
});
