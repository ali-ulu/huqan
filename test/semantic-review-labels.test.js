'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReviewLabels, main: reviewMain, REVIEW_SOURCE_ID } = require('../scripts/semantic-review-labels');
const { buildTrainingDataset } = require('../scripts/semantic-training-dataset');
const { validateTrainingRecord, trainSemanticModel } = require('../scripts/train-semantic-model');
const { main: retrainMain, retrainSemanticModel } = require('../scripts/retrain-semantic-model');
const { adaptNliRows } = require('../scripts/semantic-nli-adapter');

const FIXTURES = path.join(__dirname, 'fixtures');
const FROZEN = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'contradiction-eval-v1.corpus.json'), 'utf8')).records;
const SHA = 'a'.repeat(40);
const provenance = (decisionId, extra = {}) => ({ source: REVIEW_SOURCE_ID, decisionId, reviewer: 'ali', decidedAt: '2026-10-08T10:00:00.000Z', ...extra });
const decision = (stored, incoming, verdict, decisionId) => ({ stored: { text: stored }, incoming: { text: incoming }, verdict, provenance: provenance(decisionId) });
const reviewInput = (decisions = [
  decision('Kapı açık.', 'Kapı kapalı.', 'accepted', 'dec-1'),
  decision('Toplantı salı günü.', 'Toplantı çarşamba günü.', 'rejected', 'dec-2'),
  decision('Ağaç yeşil.', 'Ağaç mavi.', 'accepted', 'dec-3'),
  decision('Su soğuk.', 'Su sıcak.', 'rejected', 'dec-4'),
]) => ({ schemaVersion: 'huqan-review-decisions-v1',
  source: { license: 'CC0-1.0', url: 'https://example.org/review', attribution: 'Test review decisions' }, decisions });

function nliBase() {
  const sample = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'semantic-training-v1/snli-sample.json'), 'utf8'));
  const teacher = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'semantic-training-v1/independent-teacher.json'), 'utf8'));
  const adapted = adaptNliRows(sample.rows, { sourceId: 'snli', sourceVersion: '1.0' });
  return { records: adapted.records, teachers: [...adapted.teachers, ...teacher.outputs],
    sources: [{ id: 'snli', license: sample.license, url: sample.source, attribution: sample.attribution }] };
}

test('verdicts map deterministically to labels and provenance survives into the dataset', () => {
  const labels = buildReviewLabels(reviewInput(), { frozenCorpus: FROZEN });
  const dataset = buildTrainingDataset({ ...labels, frozenCorpus: FROZEN, sourceCommit: SHA });
  const byText = new Map(dataset.records.map(record => [record.stored.text, record]));
  assert.equal(byText.get('Kapı açık.').distribution.CONTRADICTION, 1);
  assert.equal(byText.get('Toplantı salı günü.').distribution.NEUTRAL, 1);
  assert.equal(byText.get('Toplantı salı günü.').distribution.ENTAILMENT, 0);
  assert.deepEqual(byText.get('Ağaç yeşil.').provenance, { source: 'conflict-review', decisionId: 'dec-3', reviewer: 'ali',
    decidedAt: '2026-10-08T10:00:00.000Z', verdict: 'accepted' });
  assert.deepEqual(byText.get('Ağaç yeşil.').teacherSet, [{ teacherId: 'human-review', teacherVersion: 'huqan-review-decisions-v1' }]);
});

test('the export is independent of decision order', () => {
  const decisions = reviewInput().decisions;
  assert.deepEqual(buildReviewLabels(reviewInput(), { frozenCorpus: FROZEN }),
    buildReviewLabels(reviewInput([...decisions].reverse()), { frozenCorpus: FROZEN }));
});

test('malformed decisions and unsupported sources are refused', () => {
  const refuse = (input, code) => assert.throws(() => buildReviewLabels(input, { frozenCorpus: FROZEN }), error => (error.code || error.message) === code);
  const base = reviewInput();
  refuse({ ...base, extra: true }, 'review_input_invalid');
  refuse({ ...base, schemaVersion: 'other' }, 'review_schema_invalid');
  refuse({ ...base, decisions: [] }, 'review_decisions_empty');
  refuse(reviewInput([{ ...base.decisions[0], verdict: 'entailment' }]), 'review_verdict_invalid');
  refuse(reviewInput([{ ...base.decisions[0], unexpected: 1 }]), 'review_decision_invalid');
  refuse(reviewInput([{ ...base.decisions[0], stored: { text: '  ' } }]), 'review_claim_invalid');
  refuse(reviewInput([{ ...base.decisions[0], provenance: provenance('dec-x', { source: 'negative-learning' }) }]), 'review_source_unsupported');
  refuse(reviewInput([{ ...base.decisions[0], provenance: provenance('dec-x', { decidedAt: 'yesterday' }) }]), 'review_provenance_invalid');
  refuse(reviewInput([base.decisions[0], { ...base.decisions[0], verdict: 'rejected' }]), 'review_pair_duplicate');
});

test('a review decision on an R50 holdout pair is refused in either order', () => {
  const holdout = FROZEN.find(record => record.split === 'holdout');
  const forward = reviewInput([decision(holdout.stored.text, holdout.incoming.text, 'accepted', 'dec-h')]);
  const reversed = reviewInput([decision(holdout.incoming.text, holdout.stored.text, 'rejected', 'dec-r')]);
  assert.throws(() => buildReviewLabels(forward, { frozenCorpus: FROZEN }), /semantic_holdout_leakage/);
  assert.throws(() => buildReviewLabels(reversed, { frozenCorpus: FROZEN }), /semantic_holdout_leakage/);
});

test('a human review label is the gold teacher and is never averaged with model teachers', () => {
  const input = { stored: { text: 'A' }, incoming: { text: 'B' } };
  const output = (teacherId, distribution) => ({ teacherId, teacherVersion: '1', input, distribution, latencyMs: 0 });
  const data = {
    records: [{ ...input, split: 'train', sourceId: 'authored' }],
    sources: [{ id: 'authored', license: 'CC0-1.0', url: 'https://example.org/source', attribution: 'Test fixture' }],
    frozenCorpus: [{ stored: { text: 'C' }, incoming: { text: 'D' }, split: 'holdout' }],
    sourceCommit: SHA,
    teachers: [
      output('model-a', { CONTRADICTION: 1, ENTAILMENT: 0, NEUTRAL: 0, ABSTAIN: 0 }),
      output('model-b', { CONTRADICTION: 1, ENTAILMENT: 0, NEUTRAL: 0, ABSTAIN: 0 }),
      output('human-review', { CONTRADICTION: 0, ENTAILMENT: 1, NEUTRAL: 0, ABSTAIN: 0 }),
    ],
  };
  const [record] = buildTrainingDataset(data).records;
  assert.equal(record.distribution.ENTAILMENT, 1);
  assert.equal(record.needsReview, false);
  assert.equal(record.weight, 1);
  assert.deepEqual(record.teacherSet, [{ teacherId: 'human-review', teacherVersion: '1' }]);
  assert.doesNotThrow(() => validateTrainingRecord(record));
});

test('model-only pairs still need a quorum, and two human labels on one pair are refused', () => {
  const data = { records: [{ stored: { text: 'A' }, incoming: { text: 'B' }, split: 'train', sourceId: 'authored' }],
    sources: [{ id: 'authored', license: 'CC0-1.0', url: 'https://example.org/source', attribution: 'Test fixture' }],
    frozenCorpus: [{ stored: { text: 'C' }, incoming: { text: 'D' }, split: 'holdout' }], sourceCommit: SHA };
  const teacher = (teacherId, label) => ({ teacherId, teacherVersion: '1', input: { stored: { text: 'A' }, incoming: { text: 'B' } },
    distribution: Object.fromEntries(['CONTRADICTION', 'ENTAILMENT', 'NEUTRAL', 'ABSTAIN'].map(name => [name, Number(name === label)])), latencyMs: 0 });
  assert.throws(() => buildTrainingDataset({ ...data, teachers: [teacher('model-a', 'NEUTRAL')] }), /teacher_quorum_missing/);
  assert.throws(() => buildTrainingDataset({ ...data, teachers: [teacher('human-review', 'NEUTRAL'), teacher('human-review', 'NEUTRAL')] }),
    /human_review_label_conflict|teacher_duplicate/);
});

test('retrain writes a new digest-named triple, is byte-identical across runs, and never overwrites', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-retrain-'));
  try {
    const basePath = path.join(directory, 'base.json');
    const decisionsPath = path.join(directory, 'decisions.json');
    const labelsPath = path.join(directory, 'labels.json');
    fs.writeFileSync(basePath, JSON.stringify(nliBase()));
    fs.writeFileSync(decisionsPath, JSON.stringify(reviewInput()));
    assert.equal(reviewMain([decisionsPath, labelsPath]), '4 review labels');
    const run = outDir => retrainMain([basePath, labelsPath, 'SSM', SHA, outDir]);
    const first = path.join(directory, 'run-1');
    const second = path.join(directory, 'run-2');
    const report = run(first);
    assert.equal(run(second), report);
    const names = fs.readdirSync(first).sort();
    assert.equal(names.length, 3);
    for (const name of names) assert.equal(fs.readFileSync(path.join(first, name), 'utf8'), fs.readFileSync(path.join(second, name), 'utf8'));
    const parsed = JSON.parse(report);
    assert.match(parsed.artifactDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(parsed.calibrationDigest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(parsed.previous.artifactDigest.startsWith('sha256:'));
    assert.notEqual(parsed.artifactDigest, parsed.previous.artifactDigest);
    assert.throws(() => run(first), /retrain_output_exists/);
    assert.deepEqual(fs.readdirSync(first).sort(), names);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the retrain pipeline counts human labels in training and calibration, not as a separate source', () => {
  const labels = buildReviewLabels(reviewInput(), { frozenCorpus: FROZEN });
  const result = retrainSemanticModel({ base: nliBase(), reviewLabels: labels, family: 'SSM', sourceCommit: SHA, frozenCorpus: FROZEN });
  const human = result.dataset.records.filter(record => record.teacherSet.some(t => t.teacherId === 'human-review'));
  assert.equal(human.length, 4);
  assert.ok(human.every(record => record.weight === 1 && record.needsReview === false));
  assert.equal(result.artifact.teacherSet.some(t => t.teacherId === 'human-review'), true);
  assert.equal(result.calibration.family, 'SSM');
  assert.deepEqual(trainSemanticModel(result.dataset, { family: 'SSM', sourceCommit: SHA }), result.artifact);
});
