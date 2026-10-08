'use strict';

// R51 PR3 (#3583): the Core seam for the own-weight semantic model. Mode
// parsing, fail-closed behaviour, the calibrator hook and the review-priority
// rule are pinned here; the live verify wiring is in
// semantic-model-live-wiring.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveSemanticModelMode,
  evaluateSemanticModel,
  strongestSemanticModel,
  semanticModelReceiptView,
} = require('../lib/semantic-model-port');
const { createSemanticModelProvider, FAMILY_FILES } = require('../lib/semantic-model-provider');

const ARTIFACT_DIR = path.join(__dirname, '..', 'lib', 'semantic-model-artifacts');
const STORED = { text: 'paris is the capital of france', subject: 'paris' };
const INCOMING = { text: 'paris is not the capital of france', subject: 'paris' };
const DISTRIBUTION = { CONTRADICTION: 0.7, ENTAILMENT: 0.1, NEUTRAL: 0.15, ABSTAIN: 0.05 };
const fakeProvider = () => ({ family: 'SSM', artifactDigest: 'sha256:test', distribution: DISTRIBUTION });

test('mode defaults to shadow, accepts off|shadow|on in any case, and fails closed to off', () => {
  assert.equal(resolveSemanticModelMode({}), 'shadow');
  assert.equal(resolveSemanticModelMode({ HUQAN_SEMANTIC_MODEL: '' }), 'shadow');
  assert.equal(resolveSemanticModelMode({ HUQAN_SEMANTIC_MODEL: 'OFF' }), 'off');
  assert.equal(resolveSemanticModelMode({ HUQAN_SEMANTIC_MODEL: ' on ' }), 'on');
  assert.equal(resolveSemanticModelMode({ HUQAN_SEMANTIC_MODEL: 'shadow' }), 'shadow');
  assert.equal(resolveSemanticModelMode({ HUQAN_SEMANTIC_MODEL: 'enabled' }), 'off');
});

test('mode off and an unwired process both produce no signal at all', () => {
  assert.equal(evaluateSemanticModel(STORED, INCOMING, { mode: 'off', provider: fakeProvider }), null);
  assert.equal(evaluateSemanticModel(STORED, INCOMING, { env: { HUQAN_SEMANTIC_MODEL: 'bogus' }, provider: fakeProvider }), null);
  assert.equal(evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow' }), null);
});

test('an uncalibrated prediction is reported but always sits in the ABSTAIN band', () => {
  const signal = evaluateSemanticModel(STORED, INCOMING, { mode: 'on', provider: fakeProvider });
  assert.equal(signal.label, 'CONTRADICTION');
  assert.equal(signal.band, 'ABSTAIN');
  assert.equal(signal.calibrated, false);
  assert.equal(signal.reason, 'uncalibrated');
  assert.equal(signal.reviewPriority, 0);
  assert.equal(signal.authority, 'CANDIDATE_ONLY');
});

test('a calibrator with a confident band is honoured; only mode on turns it into review priority', () => {
  const calibrator = () => ({ distribution: DISTRIBUTION, band: 'CONFIDENT' });
  const on = evaluateSemanticModel(STORED, INCOMING, { mode: 'on', provider: fakeProvider, calibrator });
  assert.equal(on.band, 'CONFIDENT');
  assert.equal(on.calibrated, true);
  assert.equal(on.reason, null);
  assert.equal(on.reviewPriority, 0.7);
  const shadow = evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow', provider: fakeProvider, calibrator });
  assert.equal(shadow.band, 'CONFIDENT');
  assert.equal(shadow.reviewPriority, 0);
});

test('a calibrator answer that is malformed is ignored, and one that throws fails closed', () => {
  const malformed = evaluateSemanticModel(STORED, INCOMING, {
    mode: 'on', provider: fakeProvider, calibrator: () => ({ distribution: { CONTRADICTION: 2 }, band: 'CONFIDENT' }),
  });
  assert.equal(malformed.calibrated, false);
  assert.equal(malformed.band, 'ABSTAIN');
  const thrown = evaluateSemanticModel(STORED, INCOMING, {
    mode: 'on', provider: fakeProvider, calibrator: () => { throw new Error('boom'); },
  });
  assert.equal(thrown.band, 'ABSTAIN');
  assert.equal(thrown.p, null);
  assert.equal(thrown.reason, 'calibration_failed:boom');
});

test('a missing artifact, a tampered artifact or an unknown family fails closed with a reason', () => {
  const missing = createSemanticModelProvider({ env: {}, artifactDir: path.join(os.tmpdir(), 'no-such-r51-dir') });
  assert.equal(evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow', provider: missing }).reason,
    'artifact_unavailable:semantic_artifact_missing');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r51-artifact-'));
  try {
    const artifact = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, FAMILY_FILES.SSM), 'utf8'));
    // Still a valid Float32 weight, so only the digest check can catch it.
    artifact.weights[0][0] = Math.fround(artifact.weights[0][0] + 0.5);
    fs.writeFileSync(path.join(dir, FAMILY_FILES.SSM), JSON.stringify(artifact));
    const tampered = evaluateSemanticModel(STORED, INCOMING, {
      mode: 'shadow', provider: createSemanticModelProvider({ env: {}, artifactDir: dir }),
    });
    assert.equal(tampered.band, 'ABSTAIN');
    assert.match(tampered.reason, /^artifact_unavailable:semantic_weights_digest_mismatch$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const unknown = createSemanticModelProvider({ env: { HUQAN_SEMANTIC_MODEL_FAMILY: 'gpt' } });
  assert.equal(evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow', provider: unknown }).reason,
    'artifact_unavailable:semantic_family_unknown');
});

test('unsupported input, a prediction error or an invalid distribution fails closed instead of throwing', () => {
  const real = createSemanticModelProvider({ env: {} });
  const empty = evaluateSemanticModel(STORED, { text: '' }, { mode: 'shadow', provider: real });
  assert.equal(empty.reason, 'input_unsupported:incoming_text_missing');
  const nonString = evaluateSemanticModel({ text: 42 }, INCOMING, { mode: 'shadow', provider: real });
  assert.equal(nonString.reason, 'input_unsupported:stored_text_missing');
  const long = evaluateSemanticModel(STORED, { text: 'x'.repeat(2049) }, { mode: 'shadow', provider: real });
  assert.equal(long.reason, 'input_unsupported:incoming_text_too_long');
  assert.equal(long.band, 'ABSTAIN');

  const nan = evaluateSemanticModel(STORED, INCOMING, {
    mode: 'shadow', provider: () => ({ family: 'SSM', artifactDigest: 'sha256:x', distribution: { CONTRADICTION: NaN } }),
  });
  assert.equal(nan.reason, 'prediction_failed:distribution_invalid');
  assert.equal(nan.family, 'SSM');
  const throwing = evaluateSemanticModel(STORED, INCOMING, {
    mode: 'shadow', provider: () => { throw new Error('kaboom'); },
  });
  assert.equal(throwing.reason, 'prediction_failed:kaboom');
});

test('a distribution that does not sum to one is rejected, even with a confident calibrator', () => {
  const short = { CONTRADICTION: 0.2, ENTAILMENT: 0.1, NEUTRAL: 0.1, ABSTAIN: 0.1 };
  const signal = evaluateSemanticModel(STORED, INCOMING, {
    mode: 'on',
    provider: () => ({ family: 'SSM', artifactDigest: 'sha256:x', distribution: short }),
    calibrator: () => ({ distribution: short, band: 'CONFIDENT' }),
  });
  assert.equal(signal.reason, 'prediction_failed:distribution_invalid');
  assert.equal(signal.reviewPriority, 0);
});

test('each packaged family loads, answers with its own digest, and the load happens once', () => {
  for (const [family, file] of Object.entries(FAMILY_FILES)) {
    const expected = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, file), 'utf8')).artifactDigest;
    const signal = evaluateSemanticModel(STORED, INCOMING, {
      mode: 'shadow', provider: createSemanticModelProvider({ env: { HUQAN_SEMANTIC_MODEL_FAMILY: family.toLowerCase() } }),
    });
    assert.equal(signal.family, family);
    assert.equal(signal.artifactDigest, expected);
    assert.equal(Object.values(signal.p).reduce((a, b) => a + b, 0).toFixed(6), '1.000000');
  }

  const reads = [];
  const original = fs.readFileSync;
  fs.readFileSync = function spy(file, ...rest) {
    if (String(file).includes('semantic-model-artifacts')) reads.push(file);
    return original.call(this, file, ...rest);
  };
  try {
    const provider = createSemanticModelProvider({ env: {} });
    for (let i = 0; i < 5; i++) evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow', provider });
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(reads.length, 1);
});

test('the strongest signal is the most contradictory one; the receipt view keeps the audit fields only', () => {
  const low = { p: { CONTRADICTION: 0.2 } };
  const high = { p: { CONTRADICTION: 0.6 } };
  const failed = { p: null };
  assert.equal(strongestSemanticModel([failed, low, null, high]), high);
  assert.equal(strongestSemanticModel([null, null]), null);
  // A calibrated review priority outranks a higher raw contradiction probability.
  const prioritised = { reviewPriority: 0.8, p: { CONTRADICTION: 0.8 } };
  const abstained = { reviewPriority: 0, p: { CONTRADICTION: 0.85 } };
  assert.equal(strongestSemanticModel([abstained, prioritised]), prioritised);

  const signal = evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow', provider: fakeProvider });
  assert.deepEqual(Object.keys(semanticModelReceiptView(signal)).sort(),
    ['artifactDigest', 'band', 'family', 'mode', 'p', 'reason', 'reviewPriority']);
  assert.equal(semanticModelReceiptView(null), null);
});

test('a warm prediction stays inside the 5 ms per-pair budget (p95 over 1000 pairs)', () => {
  const provider = createSemanticModelProvider({ env: {} });
  for (let i = 0; i < 100; i++) evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow', provider });
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    const start = process.hrtime.bigint();
    evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow', provider });
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[949] < 5, `p95 ${samples[949]} ms`);
});
