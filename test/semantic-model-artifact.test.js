'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildArtifact, parseArtifact, validateArtifact, MAX_ARTIFACT_BYTES } = require('../lib/semantic-model-artifact');
const { STEPS } = require('../lib/semantic-model-text-features');
function fixture() {
  return buildArtifact({ family: 'MAMBA', config: { seed: 3583, reservoir: 8, ridge: 0.5, steps: STEPS },
    weights: Array.from({ length: 4 }, () => Array(STEPS + 9).fill(0.1)), trainCorpusDigest: `sha256:${'a'.repeat(64)}`,
    sourceCommit: 'b'.repeat(40), encoderDigest: `sha256:${'c'.repeat(64)}`,
    teacherSet: ['a', 'b'].map(teacherId => ({ teacherId, teacherVersion: '1' })) });
}
test('own-weight artifacts quantize Float32 readouts and replay their canonical identity', () => {
  const artifact = fixture();
  assert.equal(artifact.weights[0][0], Math.fround(0.1));
  assert.deepEqual(artifact, fixture());
  assert.deepEqual(parseArtifact(JSON.stringify(artifact)), artifact);
});
test('unknown specs, changed weights, malformed provenance and oversized bytes fail closed', () => {
  const artifact = fixture();
  assert.throws(() => validateArtifact({ ...artifact, featureSpecDigest: 'unknown' }), /spec_unknown/);
  const changed = structuredClone(artifact);
  changed.weights[0][0] = 1;
  assert.throws(() => validateArtifact(changed), /weights_digest_mismatch/);
  assert.throws(() => validateArtifact({ ...artifact, sourceCommit: 'unknown' }), /provenance_invalid/);
  assert.throws(() => validateArtifact({ ...artifact, extra: true }), /fields_invalid/);
  assert.throws(() => parseArtifact(' '.repeat(MAX_ARTIFACT_BYTES + 1)), /budget_exceeded/);
});

test('artifact snapshots never alias mutable caller config, teachers or weights', () => {
  const input = structuredClone(fixture());
  const artifact = buildArtifact(input);
  input.config.seed = 9;
  input.teacherSet[0].teacherVersion = 'changed';
  input.weights[0][0] = 99;
  assert.equal(artifact.config.seed, 3583);
  assert.equal(artifact.teacherSet[0].teacherVersion, '1');
  assert.equal(artifact.weights[0][0], Math.fround(0.1));
  assert.throws(() => { artifact.config.seed = 9; }, TypeError);
  assert.throws(() => { artifact.teacherSet[0].teacherVersion = 'changed'; }, TypeError);
  assert.throws(() => { artifact.weights[0][0] = 99; }, TypeError);
  assert.deepEqual(validateArtifact(artifact), artifact);
});
