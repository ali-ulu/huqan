'use strict';

/**
 * Characterization tests for the B1 baseline replay runner (#3375, slice
 * 3307-S2). They pin the invariances the slice exists to provide: a replay of a
 * frozen manifest is deterministic, the counts separate observed from censored
 * and missing, and the evaluator fails closed on a design that would make its
 * own result incomparable.
 *
 * The last group are the mutation tests the task pack asks for: each one
 * disables one check the runner must not silently perform (split overlap,
 * budget integrity, B1-only scope, manifest digest) and asserts the run is
 * rejected. They fail if the corresponding guard is removed.
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
  REPLAY_SCHEMA_VERSION,
  REPLAY_STATUS,
  REPLAY_ERROR_CODES,
  replayBaseline,
} = require('../lib/cognitive-lab-b1-replay');

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
    observations: {
      h1: 'observed', h2: 'observed', h3: 'observed', h5: 'observed',
    },
    recordedAt: '2026-09-01T00:00:00.000Z',
    outcomeAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function withGraph(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-b1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

function run(graph, m, e, opts) {
  return replayBaseline(graph, { manifest: m, manifestDigest: computeManifestDigest(m), experiment: e }, opts);
}

test('a baselined B1 run reports observed, censored and missing separately', (t) => {
  const graph = withGraph(t);
  const result = run(graph, manifest(), experiment());

  assert.equal(result.status, REPLAY_STATUS.REPLAYED);
  assert.equal(result.schemaVersion, REPLAY_SCHEMA_VERSION);
  assert.equal(result.benchmark, 'B1');
  assert.equal(result.counts.attempt, 8);
  assert.equal(result.counts.eligible, 5);
  assert.equal(result.counts.observed, 3);
  assert.equal(result.counts.censored, 1);
  assert.equal(result.counts.measurement_error, 0);
  assert.equal(result.counts.observed + result.counts.censored + result.counts.missing
    + result.counts.reported + result.counts.uncounted, result.counts.ingested);
  assert.ok(result.correctnessDigest);
  assert.equal(result.integrity.status, 'PASS');
});

test('B2-B8 stay NOT_MEASURED while B1 is measured', (t) => {
  const graph = withGraph(t);
  const result = run(graph, manifest(), experiment());
  assert.equal(result.mechanisms.B1, 'MEASURED');
  for (const id of ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']) {
    assert.equal(result.mechanisms[id], 'NOT_MEASURED', `${id} must not be measured by this slice`);
  }
});

test('replaying the same frozen baseline yields the same correctness digest', (t) => {
  const first = run(withGraph(t), manifest(), experiment());
  const second = run(withGraph(t), manifest(), experiment());
  assert.equal(first.correctnessDigest, second.correctnessDigest);
});

test('a reported effect is not counted as an observed success', (t) => {
  const graph = withGraph(t);
  const e = experiment({
    observations: { h1: 'observed', h2: 'observed', h3: 'reported', h4: 'observed', h5: 'observed' },
    outcomes: { h1: 'confirmed', h2: 'confirmed', h3: 'confirmed', h4: 'confirmed', h5: 'censored' },
  });
  const result = run(graph, manifest(), e);
  assert.equal(result.counts.observed, 3);
  assert.equal(result.counts.reported, 1);
});

test('a split that leaks a holdout id into train is rejected', (t) => {
  const graph = withGraph(t);
  const e = experiment({ split: { train: ['h1'], holdout: ['h1', 'h2'], transfer: [] } });
  const result = run(graph, manifest(), e);
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.OVERLAP);
  assert.equal(result.correctnessDigest, null);
});

test('a split whose transfer id also appears in train or holdout is rejected', (t) => {
  const graph = withGraph(t);
  for (const transfer of [['t1'], ['h1']]) {
    const e = experiment({ split: { train: ['t1', 't2', 't3'], holdout: ['h1', 'h2', 'h3', 'h4', 'h5'], transfer } });
    const result = run(graph, manifest(), e);
    assert.equal(result.status, REPLAY_STATUS.REJECT);
    assert.equal(result.error.code, REPLAY_ERROR_CODES.OVERLAP);
    assert.equal(result.correctnessDigest, null);
  }
});

test('a workflow that copies holdout labels into train fails integrity', (t) => {
  const graph = withGraph(t);
  const result = replayBaseline(
    graph,
    { manifest: manifest(), manifestDigest: computeManifestDigest(manifest()), experiment: experiment() },
    { mode: 'holdout-copy-to-train' },
  );
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.integrity.status, 'REJECT');
  assert.equal(result.error.code, REPLAY_ERROR_CODES.OVERLAP);
  assert.equal(result.correctnessDigest, null);
});

test('a tampered manifest is rejected before the run', (t) => {
  const graph = withGraph(t);
  const m = manifest();
  const result = replayBaseline(graph, { manifest: m, manifestDigest: DIGEST, experiment: experiment() });
  // The digest was computed over a different field value than the manifest holds.
  const good = run(graph, manifest(), experiment());
  assert.equal(good.status, REPLAY_STATUS.REPLAYED);
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.DIGEST_MISMATCH);
});

test('a self-consistent but schema-invalid manifest is rejected before replay', (t) => {
  const graph = withGraph(t);
  const invalid = manifest();
  invalid.budget.tokens = 'unknown';
  const result = replayBaseline(graph, {
    manifest: invalid,
    manifestDigest: computeManifestDigest(invalid),
    experiment: experiment(),
  });
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.INVALID_MANIFEST);
});

test('a non-B1 benchmark is rejected', (t) => {
  const graph = withGraph(t);
  const result = run(graph, manifest(), experiment({ benchmark: 'B2' }));
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.UNSUPPORTED);
});

test('an enabled non-B1 mechanism is rejected', (t) => {
  const graph = withGraph(t);
  const e = experiment();
  e.mechanisms = { ...e.mechanisms, B4: 'ENABLED' };
  const result = run(graph, manifest(), e);
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.B2_PRESENT);
});

test('a missing budget is rejected', (t) => {
  const graph = withGraph(t);
  const result = run(graph, manifest(), experiment({ budget: {} }));
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.INVALID_INPUT);
});

test('no observed sample is INSUFFICIENT, not a silent success', (t) => {
  const graph = withGraph(t);
  const e = experiment({
    outcomes: { h1: 'censored', h2: 'censored' },
    observations: {},
    split: { train: [], holdout: ['h1', 'h2'], transfer: [] },
  });
  const m = manifest({ split: { identity: DIGEST, train: [], holdout: ['h1', 'h2'], transfer: [] } });
  const result = run(graph, m, e);
  assert.equal(result.status, REPLAY_STATUS.INSUFFICIENT);
  assert.equal(result.counts.observed, 0);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.INSUFFICIENT_DATA);
});

test('a design that disagrees with the verified manifest is rejected', (t) => {
  const graph = withGraph(t);
  // The manifest freezes the default split; the experiment asks to replay a
  // different holdout under that same untampered manifest.
  const result = run(graph, manifest(), experiment({
    split: { train: ['t1', 't2', 't3'], holdout: ['h1', 'h2'], transfer: [] },
  }));
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.BUDGET_MISMATCH);
  assert.equal(result.correctnessDigest, null);
});

test('a design whose budget disagrees with the verified manifest is rejected', (t) => {
  const graph = withGraph(t);
  const result = run(graph, manifest(), experiment({ budget: { modelCalls: 9 } }));
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.BUDGET_MISMATCH);
});

test('an empty holdout is rejected as insufficient data', (t) => {
  const graph = withGraph(t);
  const result = run(graph, manifest(), experiment({ split: { train: ['t1'], holdout: [], transfer: [] } }));
  assert.equal(result.status, REPLAY_STATUS.REJECT);
  assert.equal(result.error.code, REPLAY_ERROR_CODES.INSUFFICIENT_DATA);
});
