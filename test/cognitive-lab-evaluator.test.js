'use strict';

/**
 * Fail-closed evaluator tests (#3376, slice 3307-S3).
 *
 * The first group pins the positive surface: a clean frozen B1 baseline is
 * EVALUATED, the measurement infrastructure PASSes, B1 maps to the Calibration
 * gain dimension, and intelligence gain stays NOT_MEASURED.
 *
 * The mutation group is the point of the slice. Each case feeds the evaluator a
 * design that disables one guard -- leakage across partitions, an authority
 * bypass, correlated examples counted twice, a non-finite measurement, a forged
 * observation, a missing outcome, an ignored budget -- and asserts the run is
 * REJECT/INSUFFICIENT with the matching code and no digest. They fail if the
 * corresponding guard is removed, so the suite is not a mirror of the
 * implementation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  MANIFEST_SCHEMA_VERSION,
  computeManifestDigest,
} = require('../lib/cognitive-lab-manifest');
const {
  EVALUATOR_SCHEMA_VERSION,
  EVALUATOR_STATUS,
  EVALUATOR_ERROR_CODES,
  GAIN_DIMENSIONS,
  evaluateGain,
} = require('../lib/cognitive-lab-evaluator');

const DIGEST = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

function manifest(overrides = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: { repository: 'ali-ulu/huqan', commit: COMMIT, dirty: false },
    fixture: { digest: DIGEST },
    split: {
      identity: DIGEST,
      train: ['t1', 't2', 't3'],
      holdout: ['h1', 'h2', 'h3', 'h4', 'h5'],
      transfer: [],
    },
    frame: { repository: 'ali-ulu/huqan', branch: 'main', environment: 'offline', task: 'B1-baseline' },
    seed: 7,
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
    budget: { modelCalls: 8, toolCalls: 0, humanCalls: 0, tokens: null, wallTimeMs: null, compute: null },
    measurementVersion: 'cognitive-lab-v0.1',
    thresholdConfigHash: DIGEST,
    ...overrides,
  };
}

function experiment(overrides = {}) {
  return {
    benchmark: 'B1',
    split: { train: ['t1', 't2', 't3'], holdout: ['h1', 'h2', 'h3', 'h4', 'h5'], transfer: [] },
    budget: { modelCalls: 8 },
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
    // h4 is missing an outcome; h5 is censored; h1..h3 are observed.
    outcomes: { h1: 'confirmed', h2: 'confirmed', h3: 'incident', h5: 'censored' },
    observations: { h1: 'observed', h2: 'observed', h3: 'observed', h5: 'observed' },
    recordedAt: '2026-09-01T00:00:00.000Z',
    outcomeAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function withGraph(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-eval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

function evaluate(graph, m, e, opts) {
  return evaluateGain(graph, { manifest: m, manifestDigest: computeManifestDigest(m), experiment: e }, opts);
}

test('a clean frozen baseline is EVALUATED and its infrastructure PASSes', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment());

  assert.equal(result.schemaVersion, EVALUATOR_SCHEMA_VERSION);
  assert.equal(result.status, EVALUATOR_STATUS.EVALUATED);
  assert.equal(result.benchmark, 'B1');
  assert.equal(result.infrastructure.status, 'PASS');
  assert.equal(result.integrity.status, 'PASS');
  assert.ok(result.correctnessDigest);
  assert.equal(result.counts.observed, 3);
  assert.equal(result.counts.censored, 1);
  assert.equal(result.counts.missing, 4);
});

test('B1 measures Calibration only; the other eight dimensions stay NOT_MEASURED', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment());
  assert.equal(result.gain.Calibration, 'MEASURED');
  for (const dimension of GAIN_DIMENSIONS) {
    if (dimension === 'Calibration') continue;
    assert.equal(result.gain[dimension], 'NOT_MEASURED', `${dimension} must not be measured by this slice`);
  }
});

test('baseline infrastructure PASS is not an intelligence gain PASS', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment());
  assert.equal(result.infrastructure.status, 'PASS');
  assert.equal(result.intelligenceGain, 'NOT_MEASURED');
  assert.notEqual(result.intelligenceGain, 'PASS');
});

test('v0.1 reports calibration non-claims and the two B1 known limitations', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment());
  assert.equal(result.calibration.brier, 'NOT_MEASURED');
  assert.equal(result.calibration.ece, 'NOT_MEASURED');
  assert.equal(result.calibration.reason, 'NO_PRE_OUTCOME_PROBABILITY');
  assert.deepEqual(
    result.knownLimitations.map((entry) => [entry.code, entry.status, entry.trackedBy]),
    [
      ['duplicate_source_independence', 'KNOWN_LIMITATION', '#3309'],
      ['support_invalidation', 'KNOWN_LIMITATION', '#3309'],
    ],
  );
});

test('evaluating the same frozen baseline twice yields the same digest', (t) => {
  const first = evaluate(withGraph(t), manifest(), experiment());
  const second = evaluate(withGraph(t), manifest(), experiment());
  assert.equal(first.correctnessDigest, second.correctnessDigest);
});

test('mutation: a split that leaks a holdout id into train is rejected', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment({ split: { train: ['h1'], holdout: ['h1', 'h2'], transfer: [] } }));
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.LEAKAGE);
  assert.equal(result.correctnessDigest, null);
});

test('mutation: a workflow that copies holdout labels into train is an authority bypass', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment(), { mode: 'holdout-copy-to-train' });
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.AUTHORITY_BYPASS);
  assert.equal(result.integrity.status, 'REJECT');
  assert.equal(result.correctnessDigest, null);
});

test('mutation: correlated examples from one source event are rejected, not double counted', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment({ sourceEvents: { 'evt-1': ['h1', 'h2'] } }));
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.DUPLICATION);
  assert.equal(result.correctnessDigest, null);
});

test('mutation: a split that lists the same id twice is rejected', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment({ split: { train: ['t1', 't1', 't2', 't3'], holdout: ['h1', 'h2', 'h3', 'h4', 'h5'], transfer: [] } }));
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.DUPLICATION);
});

test('mutation: a NaN measurement budget is rejected before any number is derived', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment({ budget: { modelCalls: Number.NaN } }));
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.NON_FINITE);
  assert.equal(result.correctnessDigest, null);
});

test('mutation: an Infinity in the frozen manifest budget is rejected', (t) => {
  const result = evaluate(withGraph(t), manifest({ budget: { modelCalls: 8, toolCalls: 0, humanCalls: 0, tokens: Number.POSITIVE_INFINITY, wallTimeMs: 'unknown', compute: 'unknown' } }), experiment());
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.NON_FINITE);
});

test('mutation: an observation declared observed with no outcome is a forged observation', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment({ observations: { h1: 'observed', h2: 'observed', h3: 'observed', h4: 'observed', h5: 'observed' } }));
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.FORGED_OBSERVATION);
  assert.equal(result.correctnessDigest, null);
});

test('mutation: an ignored budget that disagrees with the manifest is rejected', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment({ budget: { modelCalls: 9 } }));
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.BUDGET_MISMATCH);
});

test('mutation: a tampered manifest is rejected before the run', (t) => {
  const result = evaluateGain(withGraph(t), { manifest: manifest(), manifestDigest: DIGEST, experiment: experiment() });
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.INVALID_MANIFEST);
});

test('mutation: a self-consistent schema-invalid manifest is rejected', (t) => {
  const invalidManifest = manifest();
  invalidManifest.budget.tokens = 'unknown';
  const result = evaluateGain(withGraph(t), {
    manifest: invalidManifest,
    manifestDigest: computeManifestDigest(invalidManifest),
    experiment: experiment(),
  });
  assert.equal(result.status, EVALUATOR_STATUS.REJECT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.INVALID_MANIFEST);
});

test('a missing outcome is INSUFFICIENT, never a silent success', (t) => {
  const graph = withGraph(t);
  const e = experiment({
    outcomes: { h1: 'censored', h2: 'censored' },
    observations: {},
    split: { train: ['t1'], holdout: ['h1', 'h2'], transfer: [] },
  });
  const m = manifest({ split: { identity: DIGEST, train: ['t1'], holdout: ['h1', 'h2'], transfer: [] } });
  const result = evaluate(graph, m, e);
  assert.equal(result.status, EVALUATOR_STATUS.INSUFFICIENT);
  assert.equal(result.error.code, EVALUATOR_ERROR_CODES.MISSING_OUTCOME);
  assert.equal(result.counts.observed, 0);
  assert.equal(result.correctnessDigest, null);
  assert.equal(result.benchmark, 'B1');
  for (const dimension of GAIN_DIMENSIONS) {
    assert.equal(result.gain[dimension], 'NOT_MEASURED', `${dimension} must not be measured on an insufficient evaluation`);
  }
});

test('a refused evaluation keeps the benchmark but measures no gain dimension', (t) => {
  const insufficient = evaluate(withGraph(t), manifest({ split: { identity: DIGEST, train: [], holdout: ['h1', 'h2'], transfer: [] } }), experiment({
    outcomes: { h1: 'confirmed', h2: 'incident' },
    observations: { h1: 'observed', h2: 'observed' },
    split: { train: [], holdout: ['h1', 'h2'], transfer: [] },
  }));
  assert.equal(insufficient.status, EVALUATOR_STATUS.INSUFFICIENT);
  assert.equal(insufficient.error.code, EVALUATOR_ERROR_CODES.MANIFEST_INSUFFICIENT);
  assert.match(insufficient.integrity.detail, /manifest_empty_split/);
  assert.equal(insufficient.benchmark, 'B1');
  for (const dimension of GAIN_DIMENSIONS) {
    assert.equal(insufficient.gain[dimension], 'NOT_MEASURED', `${dimension} must not be measured on an insufficient replay`);
  }

  const rejected = evaluate(withGraph(t), manifest(), experiment({ budget: { modelCalls: Number.NaN } }));
  assert.equal(rejected.status, EVALUATOR_STATUS.REJECT);
  for (const dimension of GAIN_DIMENSIONS) {
    assert.equal(rejected.gain[dimension], 'NOT_MEASURED', `${dimension} must not be measured on a rejected replay`);
  }
});

test('a reported effect is not counted as an observed success', (t) => {
  const result = evaluate(withGraph(t), manifest(), experiment({
    observations: { h1: 'observed', h2: 'observed', h3: 'reported', h4: 'observed', h5: 'observed' },
    outcomes: { h1: 'confirmed', h2: 'confirmed', h3: 'confirmed', h4: 'confirmed', h5: 'censored' },
  }));
  assert.equal(result.status, EVALUATOR_STATUS.EVALUATED);
  assert.equal(result.counts.observed, 3);
  assert.equal(result.counts.reported, 1);
});
