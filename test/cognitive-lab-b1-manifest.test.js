'use strict';

// #3562 (I6c, R19) B1 slice: the manifest `mechanisms` label for B1 is
// reported by this builder, independently of the B7 runner (which this
// module never imports). Candidate-only measurement inputs; no promotion.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const { verifyManifestDigest } = require('../lib/cognitive-lab-manifest');
const { replayBaseline } = require('../lib/cognitive-lab-b1-replay');
const { B1_MEASUREMENT_VERSION, buildB1Experiment, mechanismsLabel } = require('../lib/cognitive-lab-b1-manifest');

const DIGEST = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

function input(overrides = {}) {
  return {
    split: { train: ['t1', 't2'], holdout: ['h1', 'h2', 'h3'], transfer: [] },
    seed: 7,
    outcomes: { h1: 'confirmed', h2: 'confirmed', h3: 'incident' },
    observations: { h1: 'observed', h2: 'observed', h3: 'observed' },
    source: { repository: 'ali-ulu/huqan', commit: COMMIT, dirty: false },
    fixtureDigest: DIGEST,
    budgetModelCalls: 5,
    recordedAt: '2026-09-01T00:00:00.000Z',
    outcomeAt: '2026-09-10T00:00:00.000Z',
    thresholdConfigHash: DIGEST,
    ...overrides,
  };
}

function withGraph(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-b1m-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

test('the mechanisms label is fixed to B1-only', () => {
  assert.deepEqual(mechanismsLabel(), {
    B1: 'ENABLED',
    B2: 'NOT_MEASURED',
    B3: 'NOT_MEASURED',
    B4: 'NOT_MEASURED',
    B5: 'NOT_MEASURED',
    B6: 'NOT_MEASURED',
    B7: 'NOT_MEASURED',
    B8: 'NOT_MEASURED',
  });
  assert.ok(Object.isFrozen(mechanismsLabel()));
});

test('the builder emits a digest-stable manifest triple', () => {
  const first = buildB1Experiment(input());
  const second = buildB1Experiment(input());
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.deepEqual(first.manifest.mechanisms, mechanismsLabel());
  assert.deepEqual(first.experiment.mechanisms, mechanismsLabel());
  assert.equal(first.experiment.benchmark, 'B1');
  assert.equal(first.manifest.measurementVersion, B1_MEASUREMENT_VERSION);
  assert.ok(Object.isFrozen(first.manifest));
  assert.ok(Object.isFrozen(first.experiment));
  const verified = verifyManifestDigest(first.manifest, first.manifestDigest);
  assert.equal(verified.status, 'VALID');
});

test('the triple replays candidate-only through the B1 runner', (t) => {
  const graph = withGraph(t);
  const { manifest, manifestDigest, experiment } = buildB1Experiment(input());
  const result = replayBaseline(graph, { manifest, manifestDigest, experiment });
  assert.equal(result.status, 'REPLAYED');
  assert.ok(result.correctnessDigest);
  assert.deepEqual(result.mechanisms, { ...mechanismsLabel(), B1: 'MEASURED' });
  assert.ok(result.integrity && result.integrity.status === 'PASS');
});

test('malformed inputs fail closed with typed errors', () => {
  assert.throws(() => buildB1Experiment(null), /input must be an object/);
  assert.throws(() => buildB1Experiment(input({ seed: -1 })), /seed must be a non-negative integer/);
  assert.throws(() => buildB1Experiment(input({ budgetModelCalls: 0 })), /budgetModelCalls must be a positive integer/);
  assert.throws(() => buildB1Experiment(input({ split: { train: ['t1'], holdout: 'nope', transfer: [] } })), /split.holdout/);
  assert.throws(() => buildB1Experiment(input({ outcomes: null })), /outcomes map is required/);
  assert.throws(() => buildB1Experiment(input({ fixtureDigest: 'short' })), /fixtureDigest/);
  assert.throws(() => buildB1Experiment(input({ source: { repository: 'r', commit: 'xyz', dirty: false } })), /source.commit/);
  assert.throws(() => buildB1Experiment(input({ thresholdConfigHash: null })), /thresholdConfigHash/);
});

test('the caller cannot relabel mechanisms through the input', () => {
  const built = buildB1Experiment(input({ mechanisms: { B1: 'NOT_MEASURED', B7: 'ENABLED' } }));
  assert.deepEqual(built.manifest.mechanisms, mechanismsLabel());
  assert.deepEqual(built.experiment.mechanisms, mechanismsLabel());
});
