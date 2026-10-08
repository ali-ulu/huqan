'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trainSemanticModel } = require('../scripts/train-semantic-model');
const { loadSemanticModel } = require('../lib/semantic-model-inference');
const { FAMILIES, LABELS, digest } = require('../lib/semantic-model-artifact');
const dataset = require('./fixtures/semantic-training-v1/training-dataset.json');

test('every existing family trains on real soft labels and replays own weights deterministically', () => {
  for (const family of FAMILIES) {
    const options = { family, sourceCommit: 'a'.repeat(40) };
    const artifact = trainSemanticModel(dataset, options);
    assert.deepEqual(artifact, trainSemanticModel(dataset, options));
    const model = loadSemanticModel(artifact);
    const pair = dataset.records.find(record => record.split === 'calibration');
    const prediction = model.predict(pair);
    assert.deepEqual(prediction, loadSemanticModel(JSON.stringify(artifact)).predict(pair));
    assert.equal(prediction.calibrated, false);
    assert.equal(prediction.authority, 'CANDIDATE_ONLY');
    assert.ok(LABELS.includes(prediction.label));
    assert.ok(Math.abs(Object.values(prediction.distribution).reduce((sum, p) => sum + p, 0) - 1) < 1e-6);
    assert.equal(artifact.trainCorpusDigest, digest(dataset.records.filter(r => r.split === 'train' && r.weight > 0 && !r.needsReview)
      .sort((a, b) => a.pairDigest < b.pairDigest ? -1 : a.pairDigest > b.pairDigest ? 1 : 0)));
  }
});
test('tampered datasets or a mismatched frozen encoder refuse training or inference', () => {
  assert.throws(() => trainSemanticModel({ ...dataset, corpusDigest: 'changed' }, { family: 'SSM', sourceCommit: 'a'.repeat(40) }), /digest_mismatch/);
  const artifact = trainSemanticModel(dataset, { family: 'SSM', sourceCommit: 'a'.repeat(40) });
  const { artifactDigest, ...payload } = artifact;
  payload.encoderDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => loadSemanticModel({ ...payload, artifactDigest: digest(payload) }), /encoder_digest_mismatch/);
});

test('rehashed corpora still require quorum and immutable consensus on every pair', () => {
  const { digestOf } = require('../scripts/contradiction-eval-freeze-contract');
  const rehash = value => {
    const { corpusDigest, ...payload } = value;
    return { ...payload, corpusDigest: `sha256:${digestOf(payload)}` };
  };
  const single = structuredClone(dataset);
  single.records.forEach((record, index) => { record.teacherSet = [record.teacherSet[index % 2]]; });
  assert.throws(() => trainSemanticModel(rehash(single), { family: 'SSM', sourceCommit: 'a'.repeat(40) }), /quorum_invalid/);
  const edited = structuredClone(dataset);
  edited.records[0].weight = 0.123;
  assert.throws(() => trainSemanticModel(rehash(edited), { family: 'SSM', sourceCommit: 'a'.repeat(40) }), /consensus_invalid/);
});
