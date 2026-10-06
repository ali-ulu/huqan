'use strict';

/**
 * B4 lab runner wiring (#3562, program #3306).
 *
 * The pure evaluator is unit-tested through `test/cognitive-lab-b4-transfer.test.js`.
 * These tests prove the runner (`lib/cognitive-lab-b4-experiment.js`) emits the
 * frozen Cognitive Lab manifest the B4 preregistration asks for (§15):
 * `mechanisms.B4 = 'ENABLED'` and every other mechanism `NOT_MEASURED`, a
 * candidate-only result (`authority = MODEL_AUTHORITY`, `canonical = false`,
 * no automatic promotion) and a manifest that validates VALID and is stable
 * across replays. Fail-closed cases prove a missing digest/commit/dirty flag is
 * rejected before any manifest is built.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TASKS, SOURCE_OPERATIONS, CORPUS_DIGEST, FAMILIES, runCorpus, trainTree, TASKS_V2, CORPUS_DIGEST_V2,
} = require('./helpers/cognitive-lab-b4-transfer');
const { runB4Experiment, splitIdsOf } = require('../lib/cognitive-lab-b4-experiment');
const { validateManifest, MECHANISM_IDS } = require('../lib/cognitive-lab-manifest');

const COMMIT = 'b'.repeat(40);

const trainTargetContents = () => new Set(FAMILIES.map((family) => Object.values(trainTree(family))).flat());

const cache = new Map();
function corpusOf(tasks) {
  if (!cache.has(tasks)) cache.set(tasks, runCorpus(tasks));
  return cache.get(tasks);
}

function run(tasks, digest) {
  return runB4Experiment({
    records: corpusOf(tasks),
    corpusDigest: digest,
    sourceCommit: COMMIT,
    sourceDirty: false,
    trainIds: Object.keys(SOURCE_OPERATIONS),
    tasks,
    trainContents: trainTargetContents(),
  });
}

test('the runner emits a VALID manifest with B4 ENABLED and no other mechanism', () => {
  const result = run(TASKS, CORPUS_DIGEST);
  const validated = validateManifest(result.manifest);
  assert.equal(validated.status, 'VALID');
  assert.equal(validated.manifest.mechanisms.B4, 'ENABLED');
  for (const id of MECHANISM_IDS) {
    if (id === 'B4') continue;
    assert.equal(validated.manifest.mechanisms[id], 'NOT_MEASURED', `${id} must not be enabled by this slice`);
  }
  assert.equal(result.manifestDigest, validated.digest);
});

test('the manifest split mirrors the corpus and the budget is one dispatch per arm per task', () => {
  const records = runCorpus(TASKS);
  const result = run(TASKS, CORPUS_DIGEST);
  const ids = (split) => records.filter((record) => record.split === split).map((record) => record.taskId).sort();
  assert.deepEqual(result.manifest.split.train, Object.keys(SOURCE_OPERATIONS).sort());
  assert.deepEqual(result.manifest.split.holdout, ids('holdout'));
  assert.deepEqual(result.manifest.split.transfer, ids('transfer'));
  assert.equal(result.manifest.fixture.digest, CORPUS_DIGEST);
  assert.equal(result.manifest.budget.modelCalls, records.length * 3);
});

test('the result is candidate-only and never promotes a rule', () => {
  const result = run(TASKS, CORPUS_DIGEST);
  assert.equal(result.authority, 'MODEL_AUTHORITY');
  assert.equal(result.canonical, false);
  assert.equal(result.automaticPromotion, false);
  assert.equal(result.intelligenceGain, 'NOT_MEASURED');
});

test('the confirmatory v2 corpus stays REJECT under the runner', () => {
  const result = run(TASKS_V2, CORPUS_DIGEST_V2);
  assert.equal(result.status, 'REJECT');
  assert.equal(result.reason, 'candidate_wrong_write');
  assert.equal(result.assertsGain, false);
});

test('the manifest digest is stable across replays of the same frozen inputs', () => {
  const first = run(TASKS, CORPUS_DIGEST);
  const second = run(TASKS, CORPUS_DIGEST);
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.equal(first.status, second.status);
});

test('splitIdsOf carries the frozen train ids and rejects an unknown split', () => {
  const ids = splitIdsOf([{ taskId: 'h', split: 'holdout' }], ['s1']);
  assert.deepEqual(ids, { train: ['s1'], holdout: ['h'], transfer: [] });
  assert.throws(() => splitIdsOf([{ taskId: 'z', split: 'other' }]), /unknown split/);
});

test('fail-closed: a missing or malformed input is rejected before a manifest is built', () => {
  const records = runCorpus(TASKS);
  const base = { records, corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false };
  assert.throws(() => runB4Experiment({ ...base, records: undefined }), /records are required/);
  assert.throws(() => runB4Experiment({ ...base, records: [] }), /records are required/);
  assert.throws(() => runB4Experiment({ ...base, corpusDigest: 'nope' }), /corpus digest required/);
  assert.throws(() => runB4Experiment({ ...base, sourceCommit: 'short' }), /source commit required/);
  assert.throws(() => runB4Experiment({ ...base, sourceDirty: undefined }), /explicit source dirty state required/);
});

test('fail-closed: a manifest without train ids is rejected', () => {
  assert.throws(() => runB4Experiment({
    records: runCorpus(TASKS), corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false,
  }), /split\.train is empty/);
});
