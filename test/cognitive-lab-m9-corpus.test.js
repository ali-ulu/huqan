'use strict';

// #4388 M9 holdout corpus generator and runner (#4063/#4060). The corpus is a
// deterministic seed-driven ledger; the runner locks a manifest from the frozen
// calibration split and scores the holdout once. These tests cover determinism,
// the fail-closed split audit, field validation, the power gate and the
// single-use holdout guard -- the behavior the issue's acceptance criteria name.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const corpusApi = require('../lib/cognitive-lab-m9-corpus');
const runner = require('../lib/cognitive-lab-m9-holdout');
const { evaluateValueLedgerRequest, CONTRACT } = require('../lib/cognitive-lab-m9-evaluator');

const PREREG = path.resolve(__dirname, '../docs/task-packs/cog-m9-holdout-preregistration-20261029.md');

test('the corpus is deterministic and its splits are disjoint and clean', () => {
  const first = corpusApi.buildM9Corpus({});
  const second = corpusApi.buildM9Corpus({});
  assert.equal(corpusApi.corpusDigest(first), corpusApi.corpusDigest(second));
  assert.deepEqual(corpusApi.auditSplits(first), { status: 'CLEAN', checked: 720 });
  for (const split of corpusApi.SPLIT_ORDER) assert.equal(first.splits[split].length, corpusApi.SPLIT_ROWS[split] * corpusApi.RATE_BANDS.length);
  // A different seed changes the digest; the profile changes it too.
  assert.notEqual(corpusApi.corpusDigest(corpusApi.buildM9Corpus({ seed: corpusApi.M9_SEED + 1 })), corpusApi.corpusDigest(first));
  assert.notEqual(corpusApi.corpusDigest(corpusApi.buildM9Corpus({ profile: 'uniform' })), corpusApi.corpusDigest(first));
});

test('the split audit reports a leak as LEAK and a broken audit as UNAVAILABLE', () => {
  const corpus = corpusApi.buildM9Corpus({});
  const leaked = structuredClone(corpus);
  leaked.splits.holdout[0] = { ...leaked.splits.holdout[0], decisionId: leaked.splits.train[0].decisionId };
  assert.equal(corpusApi.auditSplits(leaked).status, 'LEAK');
  const reversed = structuredClone(corpus);
  reversed.splits.holdout[0].availableAt = new Date(Date.parse(reversed.splits.holdout[0].at) - 60_000).toISOString();
  assert.equal(corpusApi.auditSplits(reversed).status, 'LEAK');
  assert.equal(corpusApi.auditSplits({ splits: null }).status, 'UNAVAILABLE');
});

test('every corpus row carries the ledger fields the evaluator validates', () => {
  const corpus = corpusApi.buildM9Corpus({});
  const fields = ['workspaceId', 'key', 'decisionId', 'at', 'availableAt', 'outcome', 'sourceGroup', 'sourceRefs', 'split'];
  for (const records of Object.values(corpus.splits)) for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), [...fields].sort());
    assert.equal(record.workspaceId, corpusApi.WORKSPACE_ID);
    assert.ok(Number.isFinite(Date.parse(record.at)) && Number.isFinite(Date.parse(record.availableAt)));
    assert.ok(record.sourceRefs.length > 0);
  }
  // The generator's request is accepted by the frozen evaluator without a throw.
  const report = evaluateValueLedgerRequest(corpusApi.m9Request(corpus, { scoreSplit: 'holdout' }));
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.assertsGain, false);
  assert.equal(report.intelligenceGain, 'NOT_MEASURED');
  assert.equal(report.coverage.covered, corpus.splits.holdout.length);
});

test('a decision never sees its own outcome: the first scored decision reads only train history', () => {
  const corpus = corpusApi.buildM9Corpus({});
  const request = corpusApi.m9Request(corpus, { scoreSplit: 'calibration' });
  const scored = request.records.filter(record => record.split === 'holdout');
  assert.equal(scored.length, corpus.splits.calibration.length);
  const first = scored[0];
  const prior = request.records.filter(record => record.decisionId !== first.decisionId && record.at <= first.at);
  assert.ok(prior.every(record => record.split !== 'holdout'), 'no calibration row is history for the first calibration decision');
});

test('the uniform anti-case has no per-key signal and does not gain', () => {
  const uniform = corpusApi.buildM9Corpus({ profile: 'uniform' });
  const report = evaluateValueLedgerRequest(corpusApi.m9Request(uniform, { scoreSplit: 'holdout' }));
  assert.equal(report.status, 'MEASURED');
  assert.notEqual(report.h1.label, 'GAIN');
});

test('a locked manifest scores the holdout once and records the same label as the evaluator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m9-run-'));
  try {
    const manifest = runner.runCalibration({ preregistration: PREREG });
    assert.equal(manifest.schemaVersion, runner.MANIFEST_SCHEMA);
    assert.equal(manifest.audit.status, 'CLEAN');
    assert.equal(manifest.lock.powerMet, true);
    assert.ok(manifest.lock.requiredSample >= CONTRACT.minimumSamples);
    assert.equal(manifest.antiCase.uniform.gain, false);
    const reportFile = path.join(dir, 'report.json');
    const report = runner.runHoldout({ manifest, reportFile, preregistration: PREREG });
    assert.equal(report.phase, 'holdout');
    assert.equal(report.assertsGain, false);
    assert.equal(report.intelligenceGain, 'NOT_MEASURED');
    assert.equal(report.coverage.covered, report.requiredSample);
    // The armed report matches a direct evaluation of the same locked prefix.
    const request = corpusApi.m9Request(corpusApi.buildM9Corpus({ seed: manifest.seed }), { scoreSplit: 'holdout', limit: report.requiredSample });
    assert.deepEqual(report.h1, evaluateValueLedgerRequest(request).h1);
    // The holdout is single-use: a second run against the same report file refuses.
    assert.throws(() => runner.runHoldout({ manifest, reportFile, preregistration: PREREG }), /M9_HOLDOUT_ALREADY_RUN/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest whose digest no longer matches the live corpus is refused before any report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m9-mismatch-'));
  try {
    const manifest = runner.runCalibration({ preregistration: PREREG });
    manifest.corpusDigest = 'deadbeef';
    assert.throws(() => runner.runHoldout({ manifest, reportFile: path.join(dir, 'r.json'), preregistration: PREREG }), /M9_MANIFEST_MISMATCH:corpusDigest/);
    assert.equal(fs.existsSync(path.join(dir, 'r.json')), false, 'a refused run leaves no report');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the power formula is the preregistered one and never drops below the contract minimum', () => {
  assert.equal(runner.requiredSample(0), CONTRACT.minimumSamples);
  assert.equal(runner.requiredSample(0.25), Math.ceil(((1.96 + 0.84) * 0.25 / runner.MIN_EFFECT) ** 2));
  assert.equal(runner.sampleSd([0, 0.5]), Math.sqrt(0.125));
  assert.throws(() => runner.sampleSd([1]), /M9_SD_NEEDS_TWO_FINITE/);
});

test('an unreadable preregistration fails closed rather than measuring', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m9-prereg-'));
  try {
    assert.throws(() => runner.runCalibration({ preregistration: path.join(dir, 'missing.md') }), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
