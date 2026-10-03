'use strict';

/**
 * Cognitive Lab strict experiment manifest (#3374, slice 3307-S1).
 *
 * The manifest is the frozen description an experiment is reproduced from, so
 * the contract is tested from the outside: what is rejected, what is
 * INSUFFICIENT, and that the digest is stable under field and id ordering. The
 * module is pure, so every case runs against the real validator.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_STATUS,
  MANIFEST_ERROR_CODES,
  CognitiveLabManifestError,
  validateManifest,
  buildManifest,
  computeManifestDigest,
  verifyManifestDigest,
} = require('../lib/cognitive-lab-manifest');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const COMMIT = '83000331c07e4c9bb592dfc75b12851d3aa3ee8a';

function validInput(overrides = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: { repository: 'ali-ulu/huqan', commit: COMMIT, dirty: false },
    fixture: { digest: DIGEST_A },
    split: {
      identity: DIGEST_B,
      train: ['exp-1', 'exp-2'],
      holdout: ['hold-1'],
      transfer: [],
    },
    frame: { repository: 'ali-ulu/huqan', branch: 'main', environment: 'ci', task: 'b1-belief-revision' },
    seed: 42,
    mechanisms: {
      B1: 'ENABLED',
      B2: 'NOT_MEASURED',
      B3: 'NOT_MEASURED',
      B4: 'NOT_MEASURED',
      B5: 'NOT_MEASURED',
      B6: 'NOT_MEASURED',
      B7: 'NOT_MEASURED',
      B8: 'NOT_MEASURED',
    },
    budget: {
      modelCalls: 100,
      toolCalls: 200,
      humanCalls: 0,
      tokens: 50000,
      wallTimeMs: 120000,
      compute: null,
    },
    measurementVersion: 'cognitive-lab-measurement-v0.1.0',
    thresholdConfigHash: DIGEST_A,
    ...overrides,
  };
}

function codesOf(result) {
  return result.errors.map((entry) => entry.code);
}

test('a complete manifest validates with a digest and frozen normalized copy', () => {
  const result = validateManifest(validInput());
  assert.equal(result.status, MANIFEST_STATUS.VALID);
  assert.deepEqual(result.errors, []);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  assert.equal(result.manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.equal(Object.isFrozen(result.manifest.mechanisms), true);
});

test('a missing field is rejected with a typed error', () => {
  const input = validInput();
  delete input.seed;
  const result = validateManifest(input);
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  assert.equal(result.digest, null);
  const entry = result.errors.find((e) => e.path === 'seed');
  assert.equal(entry.code, MANIFEST_ERROR_CODES.MISSING_FIELD);
});

test('a nested missing field is rejected with its dotted path', () => {
  const input = validInput();
  delete input.split.holdout;
  const result = validateManifest(input);
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  const entry = result.errors.find((e) => e.path === 'split.holdout');
  assert.equal(entry.code, MANIFEST_ERROR_CODES.MISSING_FIELD);
});

test('an unknown top-level field is rejected, not ignored', () => {
  const result = validateManifest(validInput({ sneaky: 'value' }));
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  const entry = result.errors.find((e) => e.path === 'sneaky');
  assert.equal(entry.code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);
});

test('an unknown nested field is rejected', () => {
  const input = validInput();
  input.budget.memoryBytes = 10;
  const result = validateManifest(input);
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  assert.ok(codesOf(result).includes(MANIFEST_ERROR_CODES.UNKNOWN_FIELD));
  assert.equal(result.errors.find((e) => e.path === 'budget.memoryBytes').code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);
});

test('prototype-named keys are unknown, not silently accepted as known fields', () => {
  const topLevel = validateManifest({ ...validInput(), constructor: 'x' });
  assert.equal(topLevel.status, MANIFEST_STATUS.REJECT);
  assert.equal(topLevel.errors.find((e) => e.path === 'constructor').code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);

  const nested = validInput();
  nested.budget.constructor = 'x';
  const nestedResult = validateManifest(nested);
  assert.equal(nestedResult.status, MANIFEST_STATUS.REJECT);
  assert.equal(nestedResult.errors.find((e) => e.path === 'budget.constructor').code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);
});

test('an own __proto__ key parsed from JSON is rejected', () => {
  const serialized = JSON.stringify(validInput());
  const withProto = JSON.parse(`{"__proto__":"x",${serialized.slice(1)}`);
  assert.ok(Object.hasOwn(withProto, '__proto__'));
  const result = validateManifest(withProto);
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  assert.equal(result.errors.find((e) => e.path === '__proto__').code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);
});

test('an unknown mechanism id is rejected and every B1-B8 flag is required', () => {
  const withUnknown = validInput();
  withUnknown.mechanisms.B9 = 'ENABLED';
  const unknownResult = validateManifest(withUnknown);
  assert.equal(unknownResult.errors.find((e) => e.path === 'mechanisms.B9').code, MANIFEST_ERROR_CODES.UNKNOWN_FIELD);

  const incomplete = validInput();
  delete incomplete.mechanisms.B7;
  const incompleteResult = validateManifest(incomplete);
  assert.equal(incompleteResult.errors.find((e) => e.path === 'mechanisms.B7').code, MANIFEST_ERROR_CODES.MISSING_FIELD);
});

test('a bad mechanism flag value is rejected', () => {
  const input = validInput();
  input.mechanisms.B1 = 'ON';
  const result = validateManifest(input);
  assert.equal(result.errors.find((e) => e.path === 'mechanisms.B1').code, MANIFEST_ERROR_CODES.INVALID_FIELD);
});

test('malformed digests, commits and non-finite counters are rejected', () => {
  assert.equal(validateManifest(validInput({ fixture: { digest: 'not-a-digest' } })).status, MANIFEST_STATUS.REJECT);
  assert.equal(validateManifest(validInput({ source: { repository: 'x', commit: 'ZZZ', dirty: false } })).status, MANIFEST_STATUS.REJECT);

  const nanInput = validInput();
  nanInput.budget.tokens = Number.NaN;
  const nanResult = validateManifest(nanInput);
  assert.equal(nanResult.errors.find((e) => e.path === 'budget.tokens').code, MANIFEST_ERROR_CODES.NON_FINITE_NUMBER);

  const infinityInput = validInput();
  infinityInput.budget.wallTimeMs = Infinity;
  assert.equal(validateManifest(infinityInput).status, MANIFEST_STATUS.REJECT);

  assert.equal(validateManifest(validInput({ seed: -1 })).status, MANIFEST_STATUS.REJECT);
});

test('null is the only representation of an unknown counter', () => {
  const input = validInput();
  input.budget.compute = null;
  assert.equal(validateManifest(input).status, MANIFEST_STATUS.VALID);
  input.budget.compute = 'unknown';
  assert.equal(validateManifest(input).status, MANIFEST_STATUS.REJECT);
});

test('an empty train or holdout split is INSUFFICIENT, not VALID', () => {
  const noTrain = validInput({ split: { identity: DIGEST_B, train: [], holdout: ['h'], transfer: [] } });
  const trainResult = validateManifest(noTrain);
  assert.equal(trainResult.status, MANIFEST_STATUS.INSUFFICIENT);
  assert.equal(trainResult.errors[0].code, MANIFEST_ERROR_CODES.EMPTY_SPLIT);
  assert.match(trainResult.digest, /^[0-9a-f]{64}$/);

  const noHoldout = validInput({ split: { identity: DIGEST_B, train: ['t'], holdout: [], transfer: [] } });
  assert.equal(validateManifest(noHoldout).status, MANIFEST_STATUS.INSUFFICIENT);
});

test('the digest is independent of field order', () => {
  const first = validInput();
  const reordered = {
    thresholdConfigHash: first.thresholdConfigHash,
    measurementVersion: first.measurementVersion,
    budget: { compute: null, wallTimeMs: 120000, tokens: 50000, humanCalls: 0, toolCalls: 200, modelCalls: 100 },
    mechanisms: { B8: 'NOT_MEASURED', B7: 'NOT_MEASURED', B6: 'NOT_MEASURED', B5: 'NOT_MEASURED', B4: 'NOT_MEASURED', B3: 'NOT_MEASURED', B2: 'NOT_MEASURED', B1: 'ENABLED' },
    seed: 42,
    frame: { task: 'b1-belief-revision', environment: 'ci', branch: 'main', repository: 'ali-ulu/huqan' },
    split: { transfer: [], holdout: ['hold-1'], train: ['exp-2', 'exp-1'], identity: DIGEST_B },
    fixture: { digest: DIGEST_A },
    source: { dirty: false, commit: COMMIT, repository: 'ali-ulu/huqan' },
    schemaVersion: MANIFEST_SCHEMA_VERSION,
  };
  assert.equal(computeManifestDigest(validateManifest(first).manifest), computeManifestDigest(validateManifest(reordered).manifest));
});

test('the digest treats split ids as sets, not ordered lists', () => {
  const ordered = validInput({ split: { identity: DIGEST_B, train: ['exp-1', 'exp-2'], holdout: ['hold-1'], transfer: [] } });
  const reordered = validInput({ split: { identity: DIGEST_B, train: ['exp-2', 'exp-1'], holdout: ['hold-1'], transfer: [] } });
  assert.equal(validateManifest(ordered).digest, validateManifest(reordered).digest);

  const duplicated = validInput({ split: { identity: DIGEST_B, train: ['exp-1', 'exp-2', 'exp-1'], holdout: ['hold-1'], transfer: [] } });
  assert.equal(validateManifest(ordered).digest, validateManifest(duplicated).digest);
});

test('a changed field changes the digest', () => {
  const base = validateManifest(validInput());
  const changed = validateManifest(validInput({ seed: 43 }));
  assert.notEqual(base.digest, changed.digest);
});

test('frame and budget are bound by the manifest digest', () => {
  const base = validateManifest(validInput()).digest;
  const frameChanged = validateManifest(validInput({
    frame: { repository: 'ali-ulu/huqan', branch: 'main', environment: 'ci', task: 'different-task' },
  })).digest;
  const budgetChanged = validateManifest(validInput({
    budget: { modelCalls: 101, toolCalls: 200, humanCalls: 0, tokens: 50000, wallTimeMs: 120000, compute: null },
  })).digest;
  assert.notEqual(base, frameChanged);
  assert.notEqual(base, budgetChanged);
});


test('buildManifest returns the frozen manifest and throws a typed error otherwise', () => {
  const built = buildManifest(validInput());
  assert.equal(built.manifest.seed, 42);
  assert.match(built.digest, /^[0-9a-f]{64}$/);

  const input = validInput();
  delete input.source;
  assert.throws(() => buildManifest(input), (thrown) => {
    assert.ok(thrown instanceof CognitiveLabManifestError);
    assert.equal(thrown.code, MANIFEST_ERROR_CODES.MISSING_FIELD);
    assert.equal(thrown.path, 'source');
    return true;
  });
});

test('verifyManifestDigest accepts the real digest and rejects a tampered manifest', () => {
  const built = buildManifest(validInput());
  assert.equal(verifyManifestDigest(built.manifest, built.digest).status, MANIFEST_STATUS.VALID);

  const tampered = { ...built.manifest, seed: 999 };
  const result = verifyManifestDigest(tampered, built.digest);
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  assert.equal(result.errors[0].code, MANIFEST_ERROR_CODES.DIGEST_MISMATCH);
});

test('verifyManifestDigest rejects a self-consistent but schema-invalid manifest', () => {
  const invalid = validInput();
  invalid.budget.tokens = 'unknown';
  const result = verifyManifestDigest(invalid, computeManifestDigest(invalid));
  assert.equal(result.status, MANIFEST_STATUS.REJECT);
  assert.equal(result.errors.find((entry) => entry.path === 'budget.tokens').code, MANIFEST_ERROR_CODES.INVALID_FIELD);
});


test('a non-object manifest is rejected rather than thrown on', () => {
  for (const value of [null, 'manifest', 42, []]) {
    const result = validateManifest(value);
    assert.equal(result.status, MANIFEST_STATUS.REJECT);
    assert.equal(result.errors[0].code, MANIFEST_ERROR_CODES.INVALID_FIELD);
  }
});
