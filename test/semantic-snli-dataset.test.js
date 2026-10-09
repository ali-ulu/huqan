'use strict';

// R55 PR3 (#3717): SNLI / SNLI-TR rows become a v1 training dataset under the
// owner's "crowd annotators are one human gold teacher" rule; the v2 learner
// and the calibration script consume it end to end.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { adaptSnliRow, buildSnliDataset, CORPORA, main } = require('../scripts/build-semantic-snli-dataset');
const { labelPair, consensus, HUMAN_ANNOTATORS_TEACHER_ID } = require('../scripts/semantic-teacher-contract');
const { validateTrainingRecord } = require('../scripts/train-semantic-model');
const { trainSemanticModelV2 } = require('../scripts/train-semantic-model-v2');
const { calibrateSemanticModel } = require('../scripts/calibrate-semantic-model');
const { stableStringify } = require('../lib/hash-chain');

const FROZEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'contradiction-eval-v1.corpus.json'), 'utf8')).records;
const SHA = 'e'.repeat(40);
const row = (premise, hypothesis, gold, votes, caption = 'c1') => ({ captionID: caption, gold_label: gold, annotator_labels: votes, sentence1: premise, sentence2: hypothesis });

test('one SNLI row becomes one record and one human-annotators soft-label teacher', () => {
  const adapted = adaptSnliRow(row('Adam gitar çalıyor.', 'Kimse müzik çalmıyor.', 'contradiction',
    ['contradiction', 'contradiction', 'neutral', 'contradiction', 'contradiction']), CORPORA.tr, 'calibration');
  assert.equal(adapted.teacher.teacherId, HUMAN_ANNOTATORS_TEACHER_ID);
  assert.deepEqual(adapted.teacher.distribution, { CONTRADICTION: 0.8, ENTAILMENT: 0, NEUTRAL: 0.2, ABSTAIN: 0 });
  assert.equal(adapted.record.split, 'calibration');
  assert.equal(adapted.record.pairGroupId, 'snli:c1');
  assert.equal(adapted.record.sourceId, 'snli-tr');
  assert.deepEqual(adaptSnliRow(row('a', 'b', '-', ['neutral']), CORPORA.en, 'train'), { drop: 'no_gold_label' });
  assert.deepEqual(adaptSnliRow(row('a', 'b', 'neutral', []), CORPORA.en, 'train'), { drop: 'no_annotator_label' });
  assert.deepEqual(adaptSnliRow(row('', 'b', 'neutral', ['neutral']), CORPORA.en, 'train'), { drop: 'text_invalid' });
});

test('the human-annotators teacher is a single gold label; other single teachers still need a quorum', () => {
  const adapted = adaptSnliRow(row('A man sleeps.', 'A man is awake.', 'contradiction', ['contradiction']), CORPORA.en, 'train');
  const label = labelPair([adapted.teacher]);
  assert.equal(label.weight, 1);
  assert.deepEqual(label.teacherSet.map(t => t.teacherId), [HUMAN_ANNOTATORS_TEACHER_ID]);
  assert.doesNotThrow(() => validateTrainingRecord({ ...adapted.record, ...label }));
  const lone = { ...adapted.teacher, teacherId: 'some-model' };
  assert.throws(() => consensus([lone]));
  assert.throws(() => labelPair([adapted.teacher, { ...adapted.teacher }]), /human_review_label_conflict/);
});

function writeCorpus(dir, prefix) {
  const train = [];
  for (let i = 0; i < 40; i++) {
    train.push(row(`The dog ${i} runs in the park.`, `The dog ${i} is ${i % 2 ? 'not running' : 'running'}.`, i % 2 ? 'contradiction' : 'entailment',
      [i % 2 ? 'contradiction' : 'entailment'], `train-${i}`));
  }
  train.push(row('The dog 0 runs in the park.', 'The dog 0 is running.', 'entailment', ['entailment'], 'train-dup'));
  train.push(row('The cat sits.', 'The cat stands.', '-', ['neutral', 'contradiction'], 'train-x'));
  const dev = [];
  for (let i = 0; i < 12; i++) {
    dev.push(row(`The bird ${i} sings.`, `The bird ${i} is ${i % 2 ? 'silent' : 'singing'}.`, i % 2 ? 'contradiction' : 'entailment',
      Array(5).fill(i % 2 ? 'contradiction' : 'entailment'), `dev-${i}`));
  }
  fs.writeFileSync(path.join(dir, `${prefix}_train.jsonl`), train.map(r => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(dir, `${prefix}_dev.jsonl`), dev.map(r => JSON.stringify(r)).join('\n'));
}

test('the dataset builder keeps corpus splits, never reads test, counts drops, and feeds training and calibration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r55-snli-'));
  try {
    writeCorpus(dir, 'snli_1.0');
    fs.writeFileSync(path.join(dir, 'snli_1.0_test.jsonl'), 'this file must never be read');
    const { dataset, counts } = await buildSnliDataset({ dir, language: 'en', trainLimit: 1000, calibrationLimit: 1000, sourceCommit: SHA, frozenCorpus: FROZEN });
    assert.deepEqual(counts, { train: 40, calibration: 12, dropped: { duplicate_pair: 1, no_gold_label: 1 } });
    assert.equal(dataset.sources[0].license, 'CC-BY-SA-4.0');
    assert.ok(dataset.records.every(r => r.teacherSet.length === 1 && r.teacherSet[0].teacherId === HUMAN_ANNOTATORS_TEACHER_ID));
    const again = await buildSnliDataset({ dir, language: 'en', trainLimit: 1000, calibrationLimit: 1000, sourceCommit: SHA, frozenCorpus: FROZEN });
    assert.equal(again.dataset.corpusDigest, dataset.corpusDigest);

    const model = trainSemanticModelV2(dataset, { language: 'en', sourceCommit: SHA, frozenCorpus: FROZEN });
    const calibration = calibrateSemanticModel(dataset, stableStringify(model), { minRecords: 50 });
    assert.equal(calibration.family, 'LOGISTIC_V2');
    assert.equal(calibration.modelArtifactDigest, model.artifactDigest);
    assert.equal(calibration.status, 'insufficient');
    assert.equal(calibration.metrics.n, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI validates its arguments and never overwrites an output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r55-snli-cli-'));
  try {
    writeCorpus(dir, 'snli_tr_1.1');
    const out = path.join(dir, 'dataset.json');
    await assert.rejects(main([dir, 'de', '10', '10', SHA, out]), /snli_language_invalid/);
    await assert.rejects(main([dir, 'tr', '0', '10', SHA, out]), /snli_limit_invalid/);
    assert.match(await main([dir, 'tr', '10', '5', SHA, out]), /^sha256:[a-f0-9]{64} \{"train":10,"calibration":5/);
    await assert.rejects(main([dir, 'tr', '10', '5', SHA, out]), /EEXIST/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
