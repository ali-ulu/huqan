'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CONTRACT } = require('../lib/cognitive-lab-b4-evaluator');
const { evaluateM3Families } = require('../lib/cognitive-lab-m3-evaluator');

function input() {
  const records = [], comparisons = [];
  for (let index = 0; index < 24; index++) {
    const familyId = `family-${index}`;
    comparisons.push({ familyId, budget: 32, sourceSnapshotHash: 'a'.repeat(64), dependencyHash: 'b'.repeat(64),
      cutoff: '2026-10-27T00:00:00.000Z', A1: [`old-${index}`], A2: [`new-${index}`] });
    for (const split of index < 8 ? ['holdout', 'transfer'] : ['holdout']) records.push({
      taskId: `${familyId}-${split}`, familyId, split,
      A1: { correct: 0, wrongWrite: 0, violations: [] }, A2: { correct: 1, wrongWrite: 0, violations: [] },
    });
  }
  return { contract: { ...CONTRACT }, records, comparisons };
}

test('family bootstrap reuses the frozen B4 contract and never promotes caller reports to gain evidence', () => {
  const data = input(), before = structuredClone(data), report = evaluateM3Families(data);
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.holdoutFamilies, 24); assert.equal(report.transferFamilies, 8);
  assert.deepEqual(report.primary, { mean: 1, interval: { lower: 1, upper: 1 } });
  assert.equal(report.clearsEffect, true); assert.equal(report.assertsGain, false);
  assert.equal(report.registered, false); assert.equal(report.intelligenceGain, 'NOT_MEASURED');
  assert.deepEqual(evaluateM3Families({ ...data, records: [...data.records].reverse() }), report);
  assert.deepEqual(data, before);
});

test('repeating a family cannot satisfy the independent-family floor', () => {
  const data = input();
  data.records.forEach(row => { row.familyId = 'same'; });
  data.comparisons = [{ ...data.comparisons[0], familyId: 'same' }];
  const report = evaluateM3Families(data);
  assert.equal(report.status, 'INSUFFICIENT'); assert.equal(report.reason, 'sample_below_minimum');
});

test('each arm trust violation rejects before small-sample and inert-selection checks', () => {
  for (const arm of ['A1', 'A2']) for (const field of ['wrongWrite', 'violations']) {
    const data = input(); data.records = data.records.slice(0, 1); data.comparisons = data.comparisons.slice(0, 1);
    data.comparisons[0].A2 = [...data.comparisons[0].A1];
    data.records[0][arm].correct = 0;
    data.records[0][arm][field] = field === 'wrongWrite' ? 1 : ['authority_violation'];
    const report = evaluateM3Families(data);
    assert.equal(report.status, 'REJECT'); assert.equal(report.reason, 'trust_violation');
  }
});

test('same selected sets are inert while different selections with equal accuracy measure zero effect', () => {
  const data = input();
  data.records.forEach(row => { row.A1.correct = 1; });
  let report = evaluateM3Families(data);
  assert.equal(report.status, 'MEASURED'); assert.equal(report.primary.mean, 0); assert.equal(report.clearsEffect, false);
  data.comparisons.forEach(row => { row.A2 = [...row.A1].reverse(); });
  report = evaluateM3Families(data);
  assert.equal(report.status, 'INSUFFICIENT'); assert.equal(report.reason, 'selection_inert');
});

test('family means weight each independent family equally instead of weighting repeats', () => {
  const data = input(), repeated = structuredClone(data.records[0]);
  for (let index = 0; index < 99; index++) data.records.push({ ...structuredClone(repeated), taskId: `repeat-${index}` });
  data.records.filter(row => row.familyId !== repeated.familyId).forEach(row => { row.A2.correct = 0; });
  assert.equal(evaluateM3Families(data).primary.mean, 1 / 24);
});

test('an unevaluated family cannot disguise inert selections in all holdout families', () => {
  const data = input(); data.comparisons.forEach(row => { row.A2 = [...row.A1]; });
  data.comparisons.push({ ...data.comparisons[0], familyId: 'not-evaluated', A2: ['different'] });
  assert.equal(evaluateM3Families(data).reason, 'selection_inert');
});

test('unknown fields, altered thresholds, missing or duplicate evidence cannot be scored', () => {
  for (const change of [data => { data.contract.minimumSamples = 1; },
    data => { data.comparisons[0].budget = 31; }, data => { data.records.push(data.records[0]); },
    data => { data.records[0].familyId = 'unknown'; }, data => { data.records[0].A1.correct = true; },
    data => { data.comparisons[0].A1.push('extra'); }, data => { data.comparisons.push(data.comparisons[0]); },
    data => { data.records[0].unobserved = true; }]) {
    const data = input(); change(data); assert.equal(evaluateM3Families(data).status, 'REJECT');
  }
});
