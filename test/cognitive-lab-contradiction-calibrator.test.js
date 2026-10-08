'use strict';

/**
 * Contradiction rule-score calibrator (#3582, R50 PR2).
 *
 * The mapping must be deterministic, monotone, digest-bound and fail-closed
 * below the sample floor. A mapping fitted on noise is not a mapping, and a
 * mapping that can be edited without the digest noticing is not frozen.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAPPING_SCHEMA_VERSION, MAPPING_STATUS, PROBABILITY_KIND, MAX_MAPPING_BINS,
  fitScoreMapping, applyMapping, verifyMappingDigest, canonicalMapping,
} = require('../lib/cognitive-lab-contradiction-calibrator');

const ELEVEN_BINS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

// 12 labelled samples: below the default floor of 10? No -- above it, so a
// default fit is FITTED. Scores are the detector `severity` values.
function samples() {
  return [
    { score: 0.0, label: 0 }, { score: 0.0, label: 0 },
    { score: 0.8, label: 0 }, { score: 0.8, label: 1 },
    { score: 0.9, label: 1 }, { score: 0.9, label: 1 },
    { score: 0.9, label: 1 }, { score: 0.9, label: 1 },
    { score: 0.9, label: 1 }, { score: 0.9, label: 0 },
    { score: 0.95, label: 1 }, { score: 0.95, label: 0 },
  ];
}

test('a fit above the floor is FITTED with a CALIBRATED probability kind', () => {
  const result = fitScoreMapping({ samples: samples() });
  assert.equal(result.status, MAPPING_STATUS.FITTED);
  assert.equal(result.probabilityKind, PROBABILITY_KIND.CALIBRATED);
  assert.equal(result.reliable, true);
  assert.equal(result.mapping.schemaVersion, MAPPING_SCHEMA_VERSION);
  assert.equal(result.mapping.sampleCount, 12);
  assert.equal(result.mapping.positives, 7);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test('the same samples produce a bit-identical mapping and digest', () => {
  const first = fitScoreMapping({ samples: samples() });
  const second = fitScoreMapping({ samples: samples() });
  assert.deepEqual(first.mapping.probabilities, second.mapping.probabilities);
  assert.equal(first.digest, second.digest);
  assert.equal(canonicalMapping(first.mapping), canonicalMapping(second.mapping));
});

test('the mapping is monotone non-decreasing in the score', () => {
  const { mapping } = fitScoreMapping({ samples: samples() });
  for (let i = 1; i < mapping.probabilities.length; i += 1) {
    assert.ok(mapping.probabilities[i] >= mapping.probabilities[i - 1],
      `probability must not fall from bin ${i - 1} to bin ${i}`);
  }
});

test('a below-floor sample is INSUFFICIENT and never yields a mapping', () => {
  const result = fitScoreMapping({ samples: [{ score: 0.9, label: 1 }] });
  assert.equal(result.status, MAPPING_STATUS.INSUFFICIENT);
  assert.equal(result.mapping, null);
  assert.equal(result.digest, null);
  assert.equal(result.reliable, false);
  assert.equal(result.reason, 'sample_below_minimum');
});

test('an empty bin yields the base rate, not a hard 0 or 1', () => {
  const { mapping } = fitScoreMapping({ samples: samples() });
  const emptyBinIndex = mapping.edges.findIndex((edge) => edge === 0.5);
  assert.equal(mapping.probabilities[emptyBinIndex], mapping.prior);
  assert.ok(mapping.probabilities[emptyBinIndex] > 0 && mapping.probabilities[emptyBinIndex] < 1);
});

test('applyMapping routes a score to its bin and validates the artifact', () => {
  const { mapping } = fitScoreMapping({ samples: samples() });
  const last = mapping.probabilities.length - 1;
  // Bin membership is `score < edge`, the same convention the Cognitive Lab
  // calibration uses: severity 0.9 lands in the (0.9, 1.0] bin, not (0.8, 0.9].
  assert.equal(applyMapping(mapping, 0.9), mapping.probabilities[last]);
  assert.equal(applyMapping(mapping, 1), mapping.probabilities[last]);
  assert.equal(applyMapping(mapping, 0.05), mapping.probabilities[0]);
  assert.throws(() => applyMapping(mapping, 1.5), /between 0 and 1/);
  assert.throws(() => applyMapping(null, 0.3), /mapping is required/);
  assert.throws(() => applyMapping({ edges: [0.5, 1], probabilities: [0.3] }, 0.3), /align with the bin edges/);
  assert.throws(() => applyMapping({ edges: [0.5, 1], probabilities: [0.3, 2] }, 0.3), /between 0 and 1/);
});

test('a tampered mapping fails digest verification', () => {
  const { mapping } = fitScoreMapping({ samples: samples() });
  assert.equal(verifyMappingDigest(mapping), true);
  const tampered = { ...mapping, probabilities: [...mapping.probabilities].map(() => 1) };
  assert.equal(verifyMappingDigest(tampered), false);
  assert.equal(verifyMappingDigest({ ...mapping, sampleCount: mapping.sampleCount + 1 }), false);
  assert.equal(verifyMappingDigest(null), false);
});

test('bins and the sample floor are validated before fitting', () => {
  assert.throws(() => fitScoreMapping({ samples: [], bins: [0.5, 0.4, 1] }), /strictly increasing/);
  assert.throws(() => fitScoreMapping({ samples: [], bins: [0.5] }), /final bin edge must be 1/);
  assert.throws(() => fitScoreMapping({ samples: [], bins: [] }), /strictly increasing|1-/);
  assert.throws(() => fitScoreMapping({ samples: [], bins: new Array(MAX_MAPPING_BINS + 1).fill(0).map((_, i) => (i + 1) / (MAX_MAPPING_BINS + 1)).concat(1) }), /1-/);
  assert.throws(() => fitScoreMapping({ samples: samples(), minSamples: 1 }), /at least/);
});

test('a malformed sample is rejected, not silently scored', () => {
  assert.throws(() => fitScoreMapping({ samples: [{ score: 2, label: 1 }] }), /between 0 and 1/);
  assert.throws(() => fitScoreMapping({ samples: [{ score: 0.5, label: 2 }] }), /label must be 0 or 1/);
  assert.throws(() => fitScoreMapping({ samples: [{ score: Number.NaN, label: 1 }] }), /between 0 and 1/);
  assert.throws(() => fitScoreMapping({ samples: ['x'] }), /must be an object/);
  assert.throws(() => fitScoreMapping({ samples: 'x' }), /must be an array/);
});

test('the default bins are the canonical eleven edges', () => {
  const { mapping } = fitScoreMapping({ samples: samples() });
  assert.deepEqual([...mapping.edges], ELEVEN_BINS);
});
