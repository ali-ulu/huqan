'use strict';

/**
 * B6 lab runner wiring (#3562, program #3306).
 *
 * The pure evaluator is unit-tested in `test/cognitive-lab-b6-scheduler.test.js`.
 * These tests prove the runner (`lib/cognitive-lab-b6-experiment.js`) emits the
 * frozen Cognitive Lab manifest the B6 preregistration asks for (§11/§15):
 * `mechanisms.B6 = 'ENABLED'` and every other mechanism `NOT_MEASURED`, a
 * candidate-only result (`authority = MODEL_AUTHORITY`, `canonical = false`,
 * no automatic promotion) and a manifest that validates VALID and is stable
 * across replays. Fail-closed cases prove a missing digest/commit/dirty flag is
 * rejected before any manifest is built.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { TASKS, CORPUS_DIGEST, runTask } = require('./helpers/cognitive-lab-b6-scheduler');
const { runB6Experiment, mechanismsReport } = require('../lib/cognitive-lab-b6-experiment');
const { validateManifest, MECHANISM_IDS } = require('../lib/cognitive-lab-manifest');

const COMMIT = 'b'.repeat(40);

function runCorpus() {
  return TASKS.map((task) => runTask(task));
}

let cached;
const corpus = () => (cached ||= runCorpus());

test('the runner emits a VALID manifest with B6 ENABLED and no other mechanism', () => {
  const result = runB6Experiment({ records: corpus(), corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false });
  const validated = validateManifest(result.manifest);
  assert.equal(validated.status, 'VALID');
  assert.equal(validated.manifest.mechanisms.B6, 'ENABLED');
  for (const id of MECHANISM_IDS) {
    if (id === 'B6') continue;
    assert.equal(validated.manifest.mechanisms[id], 'NOT_MEASURED', `${id} must not be enabled by this slice`);
  }
  assert.equal(result.manifestDigest, validated.digest);
});

test('the manifest split mirrors the corpus and the budget is one dispatch per arm per task', () => {
  const records = corpus();
  const result = runB6Experiment({ records, corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false });
  const ids = (split) => records.filter((record) => record.split === split).map((record) => record.taskId).sort();
  assert.deepEqual(result.manifest.split.train, ids('train'));
  assert.deepEqual(result.manifest.split.holdout, ids('holdout'));
  assert.deepEqual(result.manifest.split.transfer, ids('transfer'));
  assert.equal(result.manifest.fixture.digest, CORPUS_DIGEST);
  assert.equal(result.manifest.budget.modelCalls, records.length * 2);
});

test('the result is candidate-only and never asserts a gain', () => {
  const result = runB6Experiment({ records: corpus(), corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false });
  assert.equal(result.authority, 'MODEL_AUTHORITY');
  assert.equal(result.canonical, false);
  assert.equal(result.automaticPromotion, false);
  assert.equal(result.intelligenceGain, 'NOT_MEASURED');
  // The strengthened scheduler removes the anti-case, so the preregistered stop
  // criterion fires: the run is INSUFFICIENT and claims no gain.
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(result.reason, 'no_anticase');
  assert.equal(result.assertsGain, false);
});

test('the manifest digest is stable across replays of the same frozen inputs', () => {
  const first = runB6Experiment({ records: corpus(), corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false });
  const second = runB6Experiment({ records: corpus(), corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false });
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.equal(first.status, second.status);
});

test('mechanismsReport enables B6 only', () => {
  const report = mechanismsReport();
  assert.equal(report.B6, 'ENABLED');
  assert.equal(Object.values(report).filter((flag) => flag === 'ENABLED').length, 1);
});

test('fail-closed: a missing or malformed input is rejected before a manifest is built', () => {
  assert.throws(() => runB6Experiment({ corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false }), /records are required/);
  assert.throws(() => runB6Experiment({ records: [], corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false }), /records are required/);
  assert.throws(() => runB6Experiment({ records: corpus(), corpusDigest: 'nope', sourceCommit: COMMIT, sourceDirty: false }), /corpus digest required/);
  assert.throws(() => runB6Experiment({ records: corpus(), corpusDigest: CORPUS_DIGEST, sourceCommit: 'short', sourceDirty: false }), /source commit required/);
  assert.throws(() => runB6Experiment({ records: corpus(), corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT }), /explicit source dirty state required/);
});

test('fail-closed: a record with an unknown split is rejected', () => {
  const records = [...corpus(), { taskId: 'z', split: 'other' }];
  assert.throws(() => runB6Experiment({ records, corpusDigest: CORPUS_DIGEST, sourceCommit: COMMIT, sourceDirty: false }), /unknown split/);
});
