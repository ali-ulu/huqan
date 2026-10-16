'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTrainingDataset } = require('../scripts/semantic-training-dataset');
const input = { stored: { text: 'A' }, incoming: { text: 'B' } };
function fixture() {
  return { records: [{ ...input, split: 'train', sourceId: 'authored' }],
    sources: [{ id: 'authored', license: 'CC0-1.0', url: 'https://example.org/source', attribution: 'Test fixture' }],
    sourceCommit: 'a'.repeat(40), frozenCorpus: [{ stored: { text: 'C' }, incoming: { text: 'D' }, split: 'holdout' }],
    teachers: ['human-a', 'human-b'].map(teacherId => ({ teacherId, teacherVersion: '1', input,
      distribution: { CONTRADICTION: 0.8, ENTAILMENT: 0, NEUTRAL: 0.2, ABSTAIN: 0 }, latencyMs: 0 })) };
}
test('offline dataset retains provenance and deterministically joins teacher soft labels', () => {
  const data = fixture();
  const result = buildTrainingDataset(data);
  assert.deepEqual(result, buildTrainingDataset({ ...data, teachers: [...data.teachers].reverse() }));
  assert.equal(result.records[0].distribution.CONTRADICTION, 0.8);
  assert.equal(result.records[0].teacherSet.length, 2);
  assert.match(result.corpusDigest, /^sha256:[a-f0-9]{64}$/);
});
test('unlicensed data, missing quorum and holdout leakage prevent output', () => {
  const data = fixture();
  assert.throws(() => buildTrainingDataset({ ...data, sources: [{ ...data.sources[0], license: 'unknown' }] }), /semantic_license_invalid/);
  assert.throws(() => buildTrainingDataset({ ...data, teachers: data.teachers.slice(0, 1) }), /teacher_quorum_missing/);
  assert.throws(() => buildTrainingDataset({ ...data, frozenCorpus: [{ ...input, split: 'holdout' }] }), /semantic_holdout_leakage/);
  assert.throws(() => buildTrainingDataset({ ...data, frozenCorpus: [{ stored: { ...input.stored, sourceType: 'changed' }, incoming: input.incoming, split: 'holdout' }] }), /semantic_holdout_leakage/);
  assert.throws(() => buildTrainingDataset({ ...data, records: [...data.records, { stored: input.incoming, incoming: input.stored, split: 'calibration', sourceId: 'authored' }] }), /semantic_pair_duplicate/);
});
test('teacher disagreement is excluded pending human adjudication', () => {
  const data = fixture();
  data.teachers[1].distribution = { CONTRADICTION: 0, ENTAILMENT: 1, NEUTRAL: 0, ABSTAIN: 0 };
  const result = buildTrainingDataset(data);
  assert.equal(result.records[0].needsReview, true);
  assert.equal(result.records[0].weight, 0);
  const { pairDigest, distribution, disagreement, weight, needsReview, teacherSet, digest } = result.records[0];
  assert.equal(digest, `sha256:${require('../scripts/contradiction-eval-freeze-contract').digestOf({
    pairDigest, distribution, disagreement, weight, needsReview, teacherSet })}`);
});

test('real CLI replays identical artifacts and refuses overwrites', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-semantic-'));
  try {
    const inputFile = path.join(directory, 'input.json');
    fs.writeFileSync(inputFile, JSON.stringify(fixture()));
    const cli = path.resolve(__dirname, '../scripts/build-semantic-training-dataset.js');
    const run = output => spawnSync(process.execPath, [cli, inputFile, output], { encoding: 'utf8' });
    const first = path.join(directory, 'first.json');
    const second = path.join(directory, 'second.json');
    assert.equal(run(first).status, 0);
    assert.equal(run(second).status, 0);
    assert.equal(fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8'));
    assert.equal(run(first).status, 1);
  } finally {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});

test('committed licensed SNLI and independent teacher replay the real artifact', () => {
  const root = path.join(__dirname, 'fixtures/semantic-training-v1');
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const source = read('snli-sample.json');
  const teacher = read('independent-teacher.json');
  const { digestOf } = require('../scripts/contradiction-eval-freeze-contract');
  const annotationDigest = `sha256:${digestOf(teacher.outputs.map(({ input, distribution }) => ({ input, distribution })))}`;
  assert.equal(teacher.provenance.annotationDigest, annotationDigest);
  assert.ok(teacher.outputs.every(output => output.teacherVersion === annotationDigest));
  const expected = read('training-dataset.json');
  const adapted = require('../scripts/semantic-nli-adapter').adaptNliRows(source.rows, { sourceId: 'snli', sourceVersion: '1.0' });
  const frozenCorpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8')).records;
  const actual = buildTrainingDataset({ records: adapted.records, teachers: [...adapted.teachers, ...teacher.outputs],
    sources: [{ id: 'snli', license: source.license, url: source.source, attribution: source.attribution }],
    sourceCommit: expected.sourceCommit, frozenCorpus });
  assert.deepEqual(actual, expected);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-nli-cli-'));
  const outputFile = path.join(directory, 'dataset.json');
  try {
    const run = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/build-semantic-training-dataset.js'),
      '--nli', path.join(root, 'snli-sample.json'), path.join(root, 'independent-teacher.json'), expected.sourceCommit, outputFile], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf8')), expected);
  } finally {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    fs.rmdirSync(directory);
  }
  assert.equal(actual.records.length, 100);
  assert.ok(actual.records.some(record => record.weight > 0));
  assert.ok(actual.records.filter(record => record.needsReview).every(record => record.weight === 0));
});
