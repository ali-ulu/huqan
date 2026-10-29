'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildM10Corpus, holdoutGroups, SPLIT_SIZES, MONITORING_PROBE, canonical, sha256,
} = require('../lib/cognitive-lab-m10-corpus');
const { evaluateM10, lockGroupCount, MIN_GROUPS } = require('../lib/cognitive-lab-m10-evaluator');
const { learningProgress, rankHypothesesByCuriosity } = require('../lib/cognition/curiosity');

const corpus = buildM10Corpus();
const manifest = (over = {}) => ({
  seed: corpus.seed, preregistrationDigest: 'preregistration-sha', monitoringProbeDigest: 'monitoring-probe-sha',
  predictorVersions: [...corpus.predictorVersions], nRequired: MIN_GROUPS, ...over,
});
const executions = (groups, { error, success, difficulty = 0.5 } = {}) => ({
  candidate: groups.map((group) => ({ sourceGroup: group, attempted: 10, verified: Math.round(success * 10),
    errorSum: error * 10, selectedDifficulty: difficulty })),
  control: groups.map((group) => ({ sourceGroup: group, attempted: 10, verified: Math.round(success * 10),
    errorSum: error * 10, selectedDifficulty: difficulty })),
});
const integrity = { firewallBypass: 0, approvalBypass: 0 };
const evaluate = (overrides = {}) => evaluateM10({ corpus, manifest: manifest(), integrity, ...overrides });

test('the corpus is deterministic, group-split and carries the frozen monitoring probe', () => {
  const again = buildM10Corpus();
  assert.deepEqual(again, corpus);
  assert.notEqual(buildM10Corpus({ seed: 1 }).corpusDigest, corpus.corpusDigest);
  const counts = { monitor: 0, calibration: 0, holdout: 0 };
  for (const group of corpus.groups) counts[group.split] += 1;
  assert.deepEqual(counts, SPLIT_SIZES);
  assert.equal(new Set(corpus.groups.map((group) => group.sourceGroup)).size, corpus.groups.length);
  for (const row of corpus.monitoringHistory) {
    assert.equal(row.probeSetId, MONITORING_PROBE.probeSetId);
    assert.equal(row.frameRef, MONITORING_PROBE.frameRef);
    assert.ok(['monitor-yapabilir', 'monitor-benzer'].includes(row.sourceGroup));
  }
  assert.ok(corpus.monitoringHistory.every((row) => !holdoutGroups(corpus).includes(row.sourceGroup)));
});

test('monitoring history measures progress in the improving region and noise-guards the flat one', () => {
  assert.equal(corpus.monitoringHistory.length, 4);
  const improving = learningProgress(corpus.monitoringHistory, { region: 'yapabilir' });
  assert.equal(improving.status, 'MEASURED');
  assert.equal(improving.learningProgress, 0.6);
  const flat = learningProgress(corpus.monitoringHistory, { region: 'benzer' });
  assert.equal(flat.status, 'MEASURED');
  assert.equal(flat.learningProgress, 0);
  assert.equal(flat.noiseGuard, true);
});

test('holdout oracle values never enter the ranking', () => {
  const group = corpus.groups.find((item) => item.split === 'holdout');
  const hypotheses = group.candidates.map(({ key, region, confidence }) => ({ key, region, confidence }));
  const before = rankHypothesesByCuriosity(hypotheses, { history: corpus.monitoringHistory, finalHoldoutSourceGroups: [group.sourceGroup] });
  const mutated = buildM10Corpus();
  for (const candidate of mutated.groups.find((item) => item.sourceGroup === group.sourceGroup).candidates) candidate.oracle = !candidate.oracle;
  const after = rankHypothesesByCuriosity(hypotheses, { history: mutated.monitoringHistory, finalHoldoutSourceGroups: [group.sourceGroup] });
  assert.deepEqual(before.ranked, after.ranked);
  assert.notEqual(sha256(canonical(mutated.groups)), sha256(canonical(corpus.groups)));
});

test('a paired run with both co-primary outcomes improving reports GAIN', () => {
  const groups = holdoutGroups(corpus);
  const result = evaluate({ executions: {
    candidate: executions(groups, { error: 0.2, success: 1 }).candidate,
    control: executions(groups, { error: 0.6, success: 0.5 }).control,
  } });
  assert.equal(result.label, 'GAIN');
  assert.equal(result.error.mean, 0.4);
  assert.equal(result.success.mean, 0.5);
  assert.equal(result.assertsGain, false);
  assert.equal(result.evidenceClass, 'controlled-fixture');
  assert.equal(result.intelligenceGain, 'NOT_MEASURED');
  assert.deepEqual(result.coverage, { holdoutGroups: holdoutGroups(corpus).length, paired: holdoutGroups(corpus).length, uncovered: [] });
  assert.deepEqual(evaluate({ executions: {
    candidate: executions(groups, { error: 0.2, success: 1 }).candidate,
    control: executions(groups, { error: 0.6, success: 0.5 }).control,
  } }), result);
});

test('a significantly worse co-primary outcome reports HARM', () => {
  const groups = holdoutGroups(corpus);
  const result = evaluate({ executions: {
    candidate: executions(groups, { error: 0.6, success: 0.5 }).candidate,
    control: executions(groups, { error: 0.2, success: 1 }).control,
  } });
  assert.equal(result.label, 'HARM');
  assert.deepEqual(result.reasons.sort(), ['error_interval_upper_below_zero', 'success_interval_upper_below_zero']);
});

test('zero-centred intervals are NOT_CLEARED, not a gain', () => {
  const groups = holdoutGroups(corpus);
  const candidate = [];
  const control = [];
  groups.forEach((group, index) => {
    const worse = index % 2 === 1;
    candidate.push({ sourceGroup: group, attempted: 10, verified: 5, errorSum: (worse ? 0.6 : 0.2) * 10, selectedDifficulty: 0.5 });
    control.push({ sourceGroup: group, attempted: 10, verified: 5, errorSum: (worse ? 0.2 : 0.6) * 10, selectedDifficulty: 0.5 });
  });
  const result = evaluate({ executions: { candidate, control } });
  assert.equal(result.label, 'NOT_CLEARED');
  assert.deepEqual(result.reasons, ['co_primary_interval_includes_zero']);
});

test('easier-task drift downgrades a would-be gain to NOT_CLEARED', () => {
  const groups = holdoutGroups(corpus);
  const candidate = executions(groups, { error: 0.2, success: 1, difficulty: 0.2 }).candidate;
  const control = executions(groups, { error: 0.6, success: 0.5, difficulty: 0.5 }).control;
  const result = evaluate({ executions: { candidate, control } });
  assert.equal(result.label, 'NOT_CLEARED');
  assert.deepEqual(result.reasons, ['difficulty_drift']);
  assert.equal(result.difficulty.drift, -0.3);
});

test('below the preregistered group floor the run is INSUFFICIENT with visible coverage', () => {
  const groups = holdoutGroups(corpus);
  const fewer = groups.slice(0, 20);
  const result = evaluate({ manifest: manifest({ nRequired: 24 }), executions: {
    candidate: executions(fewer, { error: 0.2, success: 1 }).candidate,
    control: executions(fewer, { error: 0.6, success: 0.5 }).control,
  } });
  assert.equal(result.label, 'INSUFFICIENT');
  assert.deepEqual(result.reasons, ['paired_groups_below_required']);
  assert.equal(result.coverage.paired, 20);
  assert.equal(result.coverage.uncovered.length, groups.length - 20);
});

test('integrity bypass, holdout leakage and mismatched arms are rejected', () => {
  const groups = holdoutGroups(corpus);
  const valid = {
    candidate: executions(groups, { error: 0.2, success: 1 }).candidate,
    control: executions(groups, { error: 0.6, success: 0.5 }).control,
  };
  assert.equal(evaluate({ executions: valid, integrity: { firewallBypass: 1, approvalBypass: 0 } }).reasons[0],
    'firewall_or_approval_bypass');
  const leaked = { ...corpus, monitoringHistory: corpus.monitoringHistory.map((row, index) => (index === 0 ? { ...row, sourceGroup: groups[0] } : row)) };
  assert.equal(evaluateM10({ corpus: leaked, manifest: manifest(), executions: valid, integrity }).reasons[0],
    'monitoring_history_contains_holdout');
  assert.equal(evaluate({ executions: { candidate: valid.candidate, control: valid.control.slice(1) } }).reasons[0],
    'arm_group_sets_differ');
  assert.equal(evaluate({ manifest: manifest({ seed: 1 }), executions: valid }).reasons[0], 'manifest_seed_mismatch');
  assert.equal(evaluate({ executions: { candidate: valid.candidate, control: valid.control.map((row, index) => (index === 0 ? { ...row, verified: 11 } : row)) } }).reasons[0],
    'control:invalid_verified');
});

test('the group floor follows the preregistered power formula', () => {
  assert.equal(lockGroupCount(0), 24);
  assert.equal(lockGroupCount(0.1), 32);
  assert.equal(lockGroupCount(0.2), 126);
  assert.throws(() => lockGroupCount(-1), /M10_SIGMA_INVALID/);
});
