'use strict';

// R55 PR3b (#3717): the packaged v2 artifacts (SNLI-TR 1.1 and SNLI 1.0, 200k
// train pairs each, calibrated on the corpus dev split) are intact, bound to
// their calibrations, and served per language through the opt-in LOGISTIC_V2
// family. Quality is not asserted here: R55 PR4 measures it on the R50 holdout.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseArtifactV2, FAMILY } = require('../lib/semantic-model-artifact-v2');
const { FEATURE_SPEC_DIGEST } = require('../lib/semantic-model-text-features-v2');
const { loadCalibration } = require('../lib/semantic-model-calibration');
const { evaluateSemanticModel } = require('../lib/semantic-model-port');
const { createSemanticModelProvider, createSemanticModelCalibrator, DEFAULT_FAMILY } = require('../lib/semantic-model-provider');

const DIR = path.join(__dirname, '..', 'lib', 'semantic-model-artifacts');
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');
// Recorded at packaging time; a re-trained or edited artifact must update these deliberately.
const EXPECTED = Object.freeze({
  tr: 'sha256:781d0dc884b44f7d889d9955f405dacbe523d85baf430dc07155cb1b66606192',
  en: 'sha256:30ffb5028e5de2ac30b6fcbd7f187e21617be6a4faab997af10e41df20692e75',
});

for (const language of ['tr', 'en']) {
  test(`the packaged ${language} v2 artifact is intact and bound to its fitted calibration`, () => {
    const { artifact } = parseArtifactV2(read(`logistic-v2-${language}.json`));
    assert.equal(artifact.artifactDigest, EXPECTED[language]);
    assert.equal(artifact.family, FAMILY);
    assert.equal(artifact.language, language);
    assert.equal(artifact.featureSpecDigest, FEATURE_SPEC_DIGEST);
    assert.deepEqual(artifact.teacherSet.map(t => t.teacherId), ['human-annotators']);
    const calibration = loadCalibration(read(`logistic-v2-${language}.calibration.json`), { modelArtifactDigest: artifact.artifactDigest });
    assert.equal(calibration.status, 'fitted');
    assert.ok(calibration.metrics.n > 9000);
    assert.ok(calibration.metrics.ece < calibration.uncalibratedMetrics.ece);
  });
}

test('LOGISTIC_V2 serves each language with its own packaged artifact and calibration; the default family is unchanged', () => {
  assert.equal(DEFAULT_FAMILY, 'SSM');
  const env = { HUQAN_SEMANTIC_MODEL_FAMILY: 'logistic_v2' };
  const provider = createSemanticModelProvider({ env });
  const calibrator = createSemanticModelCalibrator({ env });
  const pairs = {
    tr: [{ text: 'Adam gitar çalıyor.' }, { text: 'Kimse müzik çalmıyor.' }],
    en: [{ text: 'The man is playing a guitar.' }, { text: 'Nobody is playing music.' }],
  };
  for (const [language, [stored, incoming]] of Object.entries(pairs)) {
    const signal = evaluateSemanticModel(stored, incoming, { mode: 'shadow', provider, calibrator });
    assert.equal(signal.artifactDigest, EXPECTED[language]);
    assert.equal(signal.calibrated, true);
    assert.ok(['ABSTAIN', 'CONFIDENT'].includes(signal.band));
    assert.equal(signal.reviewPriority, 0);
  }
});
