'use strict';

// R51 PR4 (#3583): the packaged calibration travels with the provider into the
// live path. Insufficient calibration abstains without claiming calibration, a
// missing file means uncalibrated, a tampered file fails closed, and a fitted
// calibration bound to the real model can open the CONFIDENT band.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { stableStringify } = require('../lib/hash-chain');
const { evaluateSemanticModel, clearSemanticModelProvider } = require('../lib/semantic-model-port');
const { installSemanticModelProvider, createSemanticModelProvider } = require('../lib/semantic-model-provider');
const { fitCalibration } = require('../lib/semantic-model-calibration');

const ARTIFACT_DIR = path.join(__dirname, '..', 'lib', 'semantic-model-artifacts');
const STORED = { text: 'paris is the capital of france' };
const INCOMING = { text: 'paris is not the capital of france' };
const CORPUS = `sha256:${'c'.repeat(64)}`;

function tempArtifacts(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r51-calibration-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const ssmArtifact = () => fs.readFileSync(path.join(ARTIFACT_DIR, 'ssm.json'), 'utf8');

test.afterEach(() => clearSemanticModelProvider());

test('the packaged (insufficient) calibration abstains with its reason and does not claim calibration', () => {
  installSemanticModelProvider({ env: {} });
  const signal = evaluateSemanticModel(STORED, INCOMING, { mode: 'on' });
  assert.equal(signal.reason, 'calibration_insufficient');
  assert.equal(signal.calibrated, false);
  assert.equal(signal.band, 'ABSTAIN');
  assert.equal(signal.reviewPriority, 0);
  // The model's own distribution is kept, not a re-scaled one.
  const raw = createSemanticModelProvider({ env: {} })({ stored: STORED, incoming: INCOMING });
  assert.deepEqual(signal.p, raw.distribution);
});

test('no calibration file next to the artifact means plainly uncalibrated', () => {
  const dir = tempArtifacts({ 'ssm.json': ssmArtifact() });
  try {
    installSemanticModelProvider({ env: {}, artifactDir: dir });
    const signal = evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow' });
    assert.equal(signal.reason, 'uncalibrated');
    assert.equal(signal.calibrated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered calibration fails closed on every call', () => {
  const calibration = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, 'ssm.calibration.json'), 'utf8'));
  calibration.abstainBand.upper = 0;
  const dir = tempArtifacts({ 'ssm.json': ssmArtifact(), 'ssm.calibration.json': JSON.stringify(calibration) });
  try {
    installSemanticModelProvider({ env: {}, artifactDir: dir });
    for (let i = 0; i < 2; i++) {
      const signal = evaluateSemanticModel(STORED, INCOMING, { mode: 'on' });
      assert.equal(signal.band, 'ABSTAIN');
      assert.equal(signal.p, null);
      assert.equal(signal.reason, 'calibration_failed:semantic_calibration_digest_mismatch');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fitted calibration bound to the real model is applied and can open the CONFIDENT band', () => {
  const predict = createSemanticModelProvider({ env: {} });
  const predictions = [];
  for (let i = 0; i < 60; i++) {
    predictions.push(predict({ stored: { text: `claim number ${i} about item ${i % 7}` }, incoming: { text: `claim ${i} says item ${i % 5} is not ${i % 3}` } }));
  }
  // Labels equal to the model's own top label: a perfectly accurate split, so
  // the fitted band leaves every prediction confident.
  const top = prediction => Object.entries(prediction.distribution).sort((a, b) => b[1] - a[1])[0][0];
  const fitted = fitCalibration(predictions, predictions.map(top), { calibrationCorpusDigest: CORPUS });
  assert.equal(fitted.status, 'fitted');

  const dir = tempArtifacts({ 'ssm.json': ssmArtifact(), 'ssm.calibration.json': stableStringify(fitted) });
  try {
    installSemanticModelProvider({ env: {}, artifactDir: dir });
    const signal = evaluateSemanticModel(STORED, INCOMING, { mode: 'on' });
    assert.equal(signal.calibrated, true);
    assert.equal(signal.band, signal.label === 'ABSTAIN' ? 'ABSTAIN' : 'CONFIDENT');
    assert.equal(signal.reviewPriority, signal.label === 'CONTRADICTION' ? signal.p.CONTRADICTION : 0);
    assert.equal(Object.values(signal.p).reduce((a, b) => a + b, 0).toFixed(6), '1.000000');
    const shadow = evaluateSemanticModel(STORED, INCOMING, { mode: 'shadow' });
    assert.equal(shadow.reviewPriority, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
