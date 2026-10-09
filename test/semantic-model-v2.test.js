'use strict';

// R55 PR2 (#3717): the own-weight v2 logistic learner, its artifact contract,
// pure-JS inference, and its place behind the existing port/provider and
// calibration.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { stableStringify } = require('../lib/hash-chain');
const { buildArtifactV2, validateArtifactV2, parseArtifactV2, FAMILY } = require('../lib/semantic-model-artifact-v2');
const { loadSemanticModelV2, ABSTAIN_LOGIT } = require('../lib/semantic-model-inference-v2');
const { encodeTextPair } = require('../lib/semantic-model-text-features-v2');
const { evaluateSemanticModel } = require('../lib/semantic-model-port');
const { createSemanticModelProvider } = require('../lib/semantic-model-provider');
const { fitCalibration, applyCalibration } = require('../lib/semantic-model-calibration');
const { trainSemanticModelV2, createLogisticTrainer, learnedTarget } = require('../scripts/train-semantic-model-v2');
const { parseArtifact } = require('../lib/semantic-model-artifact');

const FIXTURES = path.join(__dirname, 'fixtures');
const FROZEN = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'contradiction-eval-v1.corpus.json'), 'utf8')).records;
const DATASET = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'semantic-training-v1', 'training-dataset.json'), 'utf8'));
const SHA = 'c'.repeat(40);

let cached = null;
function trained() {
  if (!cached) cached = trainSemanticModelV2(DATASET, { language: 'en', sourceCommit: SHA, frozenCorpus: FROZEN });
  return cached;
}

test('the learner is deterministic: the same dataset replays a byte-identical artifact', () => {
  const again = trainSemanticModelV2(structuredClone(DATASET), { language: 'en', sourceCommit: SHA, frozenCorpus: FROZEN });
  assert.equal(stableStringify(again), stableStringify(trained()));
  // Recorded on Windows/Node 24; the semantic-model workflow replays this on
  // Linux and macOS (Node 22/24), so a platform-dependent float path shows up here.
  assert.equal(trained().weightsDigest, 'sha256:7a4493f6d824d70d9fd0ae2f91cf75b031ea186eb0b8f6f2e0737eda0ae82e0e');
  assert.equal(trained().family, FAMILY);
  assert.ok(Buffer.byteLength(stableStringify(trained())) < 10 * 1024 * 1024);
});

test('the learner refuses a tampered dataset, an unknown language and holdout leakage', () => {
  assert.throws(() => trainSemanticModelV2({ ...DATASET, records: DATASET.records.slice(1) },
    { language: 'en', sourceCommit: SHA, frozenCorpus: FROZEN }), /semantic_training_digest_mismatch/);
  assert.throws(() => trainSemanticModelV2(DATASET, { language: 'de', sourceCommit: SHA, frozenCorpus: FROZEN }), /semantic_v2_language_invalid/);
  const leaked = [{ ...DATASET.records[0], split: 'holdout' }];
  assert.throws(() => trainSemanticModelV2(DATASET, { language: 'en', sourceCommit: SHA, frozenCorpus: leaked }), /holdout/);
});

test('the artifact contract fails closed on every tampering and is not a v1 artifact', () => {
  const artifact = trained();
  const tamper = (mutate) => { const copy = structuredClone(artifact); mutate(copy); return copy; };
  assert.throws(() => validateArtifactV2(tamper(a => { a.extra = 1; })), /semantic_v2_fields_invalid/);
  assert.throws(() => validateArtifactV2(tamper(a => { a.featureSpecDigest = `sha256:${'0'.repeat(64)}`; })), /semantic_v2_spec_unknown/);
  assert.throws(() => validateArtifactV2(tamper(a => { a.language = 'de'; })), /semantic_v2_spec_unknown/);
  assert.throws(() => validateArtifactV2(tamper(a => { a.hypothesisOnly = true; })), /semantic_v2_spec_unknown/);
  assert.throws(() => validateArtifactV2(tamper(a => { a.config.order = 'shuffled'; })), /semantic_v2_config_invalid/);
  const flip = (s, at) => `${s.slice(0, at)}${s[at] === 'A' ? 'B' : 'A'}${s.slice(at + 1)}`;
  assert.throws(() => validateArtifactV2(tamper(a => { a.weightsBase64 = flip(a.weightsBase64, 1000); })), /semantic_v2_weights_digest_mismatch/);
  assert.throws(() => validateArtifactV2(tamper(a => { a.sourceCommit = 'd'.repeat(40); })), /semantic_v2_artifact_digest_mismatch/);
  assert.throws(() => parseArtifact(stableStringify(artifact)), /semantic_artifact/);
  assert.throws(() => buildArtifactV2({ ...artifact, weights: new Float32Array(3) }), /semantic_v2_weights_invalid/);
});

test('inference returns a valid candidate distribution with a finite, very low ABSTAIN logit', () => {
  const model = loadSemanticModelV2(stableStringify(trained()));
  const prediction = model.predict({ stored: { text: 'A man plays a guitar.' }, incoming: { text: 'Nobody plays music.' } });
  assert.equal(prediction.family, FAMILY);
  assert.equal(prediction.authority, 'CANDIDATE_ONLY');
  assert.equal(prediction.distribution.ABSTAIN, 0);
  assert.equal(Object.values(prediction.distribution).reduce((a, b) => a + b, 0).toFixed(9), '1.000000000');
  assert.equal(prediction.rawScores.length, 4);
  assert.equal(prediction.rawScores[3], ABSTAIN_LOGIT);
  assert.ok(prediction.rawScores.every(Number.isFinite));
});

test('the learner actually learns a cross-sentence signal on a separable synthetic task', () => {
  const trainer = createLogisticTrainer();
  const subjects = ['cat', 'dog', 'bird', 'horse', 'child', 'woman', 'man', 'girl'];
  const actions = ['runs', 'sleeps', 'eats', 'swims', 'sings', 'reads'];
  const pairs = [];
  for (const s of subjects) for (const a of actions) {
    pairs.push([`The ${s} ${a} outside.`, `The ${s} ${a}.`, 1]);
    pairs.push([`The ${s} ${a} outside.`, `The ${s} does not ${a.replace(/s$/, '')}.`, 0]);
  }
  for (let epoch = 0; epoch < 5; epoch++) {
    for (const [p, h, y] of pairs) trainer.step(encodeTextPair({ stored: { text: p }, incoming: { text: h } }, { language: 'en' }), [0, 1, 2].map(k => Number(k === y)));
  }
  const weights = trainer.finish();
  const score = (p, h) => {
    const f = encodeTextPair({ stored: { text: p }, incoming: { text: h } }, { language: 'en' });
    const s = [0, 1, 2].map(k => { let t = 0; for (let i = 0; i < f.indices.length; i++) t += weights[k * 2 ** 18 + f.indices[i]] * f.values[i]; return t; });
    return s.indexOf(Math.max(...s));
  };
  assert.equal(score('The fox jumps outside.', 'The fox does not jump.'), 0);
  assert.equal(score('The fox jumps outside.', 'The fox jumps.'), 1);
  assert.deepEqual(learnedTarget({ CONTRADICTION: 0.5, ENTAILMENT: 0, NEUTRAL: 0, ABSTAIN: 0.5 }), [1, 0, 0]);
  assert.equal(learnedTarget({ CONTRADICTION: 0, ENTAILMENT: 0, NEUTRAL: 0, ABSTAIN: 1 }), null);
});

test('the provider serves LOGISTIC_V2 per language only when that artifact exists, and fails closed otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r55-v2-'));
  const english = { stored: { text: 'The man is playing a guitar.' }, incoming: { text: 'Nobody is playing music.' } };
  const turkish = { stored: { text: 'Adam gitar çalıyor.' }, incoming: { text: 'Kimse müzik çalmıyor.' } };
  const unknown = { stored: { text: 'A man plays guitar.' }, incoming: { text: 'Nobody plays music.' } };
  const env = { HUQAN_SEMANTIC_MODEL_FAMILY: 'logistic_v2' };
  const run = (record) => evaluateSemanticModel(record.stored, record.incoming,
    { mode: 'shadow', provider: createSemanticModelProvider({ env, artifactDir: dir }) });
  try {
    assert.equal(run(english).reason, 'artifact_unavailable:semantic_artifact_missing');
    fs.writeFileSync(path.join(dir, 'logistic-v2-en.json'), stableStringify(trained()));
    const signal = run(english);
    assert.equal(signal.family, FAMILY);
    assert.equal(signal.artifactDigest, trained().artifactDigest);
    assert.equal(signal.band, 'ABSTAIN');
    assert.equal(signal.reason, 'uncalibrated');
    // Turkish routes to its own artifact, which is absent here; an unknown language never guesses.
    assert.equal(run(turkish).reason, 'artifact_unavailable:semantic_artifact_missing');
    assert.equal(run(unknown).reason, 'input_unsupported:language_unsupported:unknown');
    // The prediction carries its variant, so the paired calibrator reads the right file.
    assert.equal(createSemanticModelProvider({ env, artifactDir: dir })(english).variant, 'en');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the calibrator picks the calibration file of the variant that answered', () => {
  const { createSemanticModelCalibrator } = require('../lib/semantic-model-provider');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r55-v2-cal-'));
  const env = { HUQAN_SEMANTIC_MODEL_FAMILY: 'logistic_v2' };
  try {
    const model = loadSemanticModelV2(trained());
    const predictions = [];
    for (let i = 0; i < 60; i++) predictions.push(model.predict({ stored: { text: `The item ${i} is red.` }, incoming: { text: `The item ${i} is ${i % 2 ? 'not red' : 'red'}.` } }));
    const calibration = fitCalibration(predictions, predictions.map(p => p.label), { calibrationCorpusDigest: `sha256:${'f'.repeat(64)}` });
    fs.writeFileSync(path.join(dir, 'logistic-v2-en.json'), stableStringify(trained()));
    fs.writeFileSync(path.join(dir, 'logistic-v2-en.calibration.json'), stableStringify(calibration));
    const calibrator = createSemanticModelCalibrator({ env, artifactDir: dir });
    const english = createSemanticModelProvider({ env, artifactDir: dir })({ stored: { text: 'The man is playing a guitar.' }, incoming: { text: 'Nobody is playing music.' } });
    assert.equal(calibrator(english).calibrationDigest, calibration.calibrationDigest);
    assert.equal(calibrator({ ...english, variant: 'tr' }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2 predictions go through the existing calibration contract', () => {
  const model = loadSemanticModelV2(trained());
  const predictions = [];
  for (let i = 0; i < 60; i++) predictions.push(model.predict({ stored: { text: `item ${i} is red` }, incoming: { text: `item ${i} is ${i % 2 ? 'not red' : 'red'}` } }));
  const labels = predictions.map(p => p.label);
  const calibration = fitCalibration(predictions, labels, { calibrationCorpusDigest: `sha256:${'e'.repeat(64)}` });
  assert.equal(calibration.family, FAMILY);
  assert.equal(calibration.status, 'fitted');
  const applied = applyCalibration(predictions[0], calibration);
  assert.equal(applied.calibrated, true);
  assert.ok(applied.distribution.ABSTAIN < 1e-9);
});

test('the SNLI benchmark rejects invalid limits and a dataset with no usable pairs', async () => {
  const { main: benchmark } = require('../scripts/benchmark-semantic-v2-snli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r55-bench-'));
  try {
    for (const args of [[dir, '0'], [dir, '-5'], [dir, '1.5'], [dir, 'abc'], [dir, '10', '0'], [dir, '10', 'Infinity'], [dir, '10', '51']]) {
      await assert.rejects(benchmark(args), /must be/);
    }
    await assert.rejects(benchmark([dir, '10', '1', '--language=de']), /language must be/);
    const row = (gold) => JSON.stringify({ gold_label: gold, sentence1: 'A man sleeps.', sentence2: 'A man is awake.' });
    fs.writeFileSync(path.join(dir, 'snli_1.0_train.jsonl'), `${row('contradiction')}\n`);
    fs.writeFileSync(path.join(dir, 'snli_1.0_test.jsonl'), `${row('-')}\n`);
    await assert.rejects(benchmark([dir, '10', '1']), /no usable test pairs/);
    fs.writeFileSync(path.join(dir, 'snli_1.0_test.jsonl'), `${row('contradiction')}\n`);
    const report = await benchmark([dir, '10', '1']);
    assert.equal(report.full.testPairs, 1);
    assert.ok(Number.isFinite(report.crossSentenceGain));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
