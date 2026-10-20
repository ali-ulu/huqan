'use strict';

/**
 * Cognitive Lab manifest v2 (#4061 PR-0c, decision S1): an additive
 * `cognitiveMechanisms` block (M1..M11). v1 manifests keep validating, with the
 * same digest, and v1 still rejects the new block as an unknown field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION_V2,
  COGNITIVE_MECHANISM_IDS,
  MANIFEST_STATUS,
  MANIFEST_ERROR_CODES,
  validateManifest,
  buildManifest,
  verifyManifestDigest,
} = require('../lib/cognitive-lab-manifest');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
// Pinned from the pre-v2 implementation: v1 identity must never move.
const V1_PINNED_DIGEST = 'e8fe021c0ec98eaf7ef4d760bd04aec6b3cd82884f4e2318a492ac342000b2bd';

function v1Input() {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: { repository: 'ali-ulu/huqan', commit: '83000331c07e4c9bb592dfc75b12851d3aa3ee8a', dirty: false },
    fixture: { digest: DIGEST_A },
    split: { identity: DIGEST_B, train: ['exp-1', 'exp-2'], holdout: ['hold-1'], transfer: [] },
    frame: { repository: 'ali-ulu/huqan', branch: 'main', environment: 'ci', task: 't' },
    seed: 42,
    mechanisms: Object.fromEntries(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'].map((id) => [id, 'NOT_MEASURED'])),
    budget: { modelCalls: 1, toolCalls: 2, humanCalls: 0, tokens: 3, wallTimeMs: 4, compute: null },
    measurementVersion: 'v',
    thresholdConfigHash: DIGEST_A,
  };
}

function cognitive(flag = 'NOT_MEASURED') {
  return Object.fromEntries(COGNITIVE_MECHANISM_IDS.map((id) => [id, flag]));
}

function v2Input(overrides = {}) {
  return { ...v1Input(), schemaVersion: MANIFEST_SCHEMA_VERSION_V2, cognitiveMechanisms: cognitive(), ...overrides };
}

test('M1..M11 are the cognitive mechanism ids', () => {
  assert.deepEqual(COGNITIVE_MECHANISM_IDS, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11']);
  assert.equal(MANIFEST_SCHEMA_VERSION_V2, 'huqan-cognitive-lab-manifest-v2');
});

test('a v2 manifest with a full cognitiveMechanisms block is VALID and frozen', () => {
  const input = v2Input({ cognitiveMechanisms: { ...cognitive(), M5: 'ENABLED', M7: 'DISABLED' } });
  const result = validateManifest(input);
  assert.equal(result.status, MANIFEST_STATUS.VALID);
  assert.equal(result.manifest.cognitiveMechanisms.M5, 'ENABLED');
  assert.equal(Object.isFrozen(result.manifest.cognitiveMechanisms), true);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  assert.equal(buildManifest(input).digest, result.digest);
  assert.equal(verifyManifestDigest(input, result.digest).status, MANIFEST_STATUS.VALID);
});

test('the cognitive block changes the v2 digest', () => {
  const base = validateManifest(v2Input()).digest;
  const flipped = validateManifest(v2Input({ cognitiveMechanisms: { ...cognitive(), M1: 'ENABLED' } })).digest;
  assert.notEqual(base, flipped);
});

test('a v2 manifest requires the cognitiveMechanisms block', () => {
  const input = v2Input();
  delete input.cognitiveMechanisms;
  const result = validateManifest(input);
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  assert.equal(result.errors.find((e) => e.path === 'cognitiveMechanisms').code, MANIFEST_ERROR_CODES.MISSING_FIELD);
});

test('an unknown M id, a missing M id or a bad flag is rejected in v2', () => {
  const unknownId = validateManifest(v2Input({ cognitiveMechanisms: { ...cognitive(), M12: 'ENABLED' } }));
  assert.equal(unknownId.errors.find((e) => e.path === 'cognitiveMechanisms.M12').code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);

  const missing = cognitive();
  delete missing.M3;
  const missingResult = validateManifest(v2Input({ cognitiveMechanisms: missing }));
  assert.equal(missingResult.errors.find((e) => e.path === 'cognitiveMechanisms.M3').code, MANIFEST_ERROR_CODES.MISSING_FIELD);

  const badFlag = validateManifest(v2Input({ cognitiveMechanisms: { ...cognitive(), M2: 'MAYBE' } }));
  assert.equal(badFlag.status, MANIFEST_STATUS.REJECT);
  assert.equal(badFlag.errors.find((e) => e.path === 'cognitiveMechanisms.M2').code, MANIFEST_ERROR_CODES.INVALID_FIELD);

  const notObject = validateManifest(v2Input({ cognitiveMechanisms: 'ENABLED' }));
  assert.equal(notObject.status, MANIFEST_STATUS.REJECT);
});

test('v2 still requires the B1..B8 block and rejects B ids inside cognitiveMechanisms', () => {
  const noB = v2Input();
  delete noB.mechanisms;
  assert.equal(validateManifest(noB).status, MANIFEST_STATUS.REJECT);
  const bInCognitive = validateManifest(v2Input({ cognitiveMechanisms: { ...cognitive(), B1: 'ENABLED' } }));
  assert.equal(bInCognitive.errors.find((e) => e.path === 'cognitiveMechanisms.B1').code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);
});

test('v1 rejects the cognitiveMechanisms block as an unknown field', () => {
  const result = validateManifest({ ...v1Input(), cognitiveMechanisms: cognitive() });
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  assert.equal(result.errors.find((e) => e.path === 'cognitiveMechanisms').code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);
});

test('a v1 manifest is accepted unchanged with its pinned digest', () => {
  const result = validateManifest(v1Input());
  assert.equal(result.status, MANIFEST_STATUS.VALID);
  assert.equal(result.manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal('cognitiveMechanisms' in result.manifest, false);
  assert.equal(result.digest, V1_PINNED_DIGEST);
});

test('an unknown schema version is still rejected', () => {
  const result = validateManifest({ ...v1Input(), schemaVersion: 'huqan-cognitive-lab-manifest-v3' });
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  assert.equal(result.errors.find((e) => e.path === 'schemaVersion').code, MANIFEST_ERROR_CODES.INVALID_FIELD);
});
