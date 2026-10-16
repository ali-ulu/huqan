'use strict';

/**
 * Experience Phase 4 — learning admission tests (#2390).
 *
 * Hermetic: no I/O, no storage, no timers.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createLearningPool } = require('../lib/experience/learning');

function manifest(overrides = {}) {
  return {
    runId: 'run-1',
    outcomeStatus: 'verified',
    learningEligibility: 'positive_procedure',
    sourceHashes: ['hash-abc'],
    scope: { workspaceId: 'ws' },
    revision: 'e1',
    ...overrides,
  };
}

describe('Phase 4: admission separates the pools', () => {
  it('positive manifests are admitted with traceability', () => {
    const pool = createLearningPool();
    const res = pool.admit(manifest());
    assert.equal(res.decision, 'admitted');
    assert.deepEqual(res.record.trace.sources, ['hash-abc']);
    assert.deepEqual(res.record.trace.scope, { workspaceId: 'ws' });
    assert.deepEqual(pool.stats(), { positive: 1, failures: 0, rejected: 0 });
  });

  it('negative records go to the failure pool, never the positive one', () => {
    const pool = createLearningPool();
    const res = pool.admit(manifest({
      runId: 'run-9', outcomeStatus: 'failed', learningEligibility: 'negative_example',
    }));
    assert.equal(res.decision, 'admitted');
    assert.equal(res.record.admitted, 'failure');
    assert.deepEqual(pool.stats(), { positive: 0, failures: 1, rejected: 0 });
  });

  it('ineligible, unknown and needs_review are rejected with proof', () => {
    const pool = createLearningPool();
    for (const [eligibility, code] of [
      ['ineligible', 'rejected_ineligible'],
      ['unknown', 'rejected_unknown'],
      ['needs_review', 'rejected_needs_review'],
    ]) {
      const res = pool.admit(manifest({ runId: `run-${eligibility}`, learningEligibility: eligibility }));
      assert.equal(res.decision, 'rejected');
      assert.equal(res.code, code);
    }
    assert.equal(pool.listRejected().length, 3);
    assert.deepEqual(pool.stats(), { positive: 0, failures: 0, rejected: 3 });
  });

  it('missing hash or scope abstains explicitly', () => {
    const pool = createLearningPool();
    assert.deepEqual(pool.admit(manifest({ sourceHashes: [] })).code, 'abstain_insufficient_data');
    assert.deepEqual(pool.admit(manifest({ scope: null })).code, 'abstain_insufficient_data');
    assert.deepEqual(pool.admit(manifest({ runId: '' })).code, 'abstain_insufficient_data');
    assert.deepEqual(pool.stats(), { positive: 0, failures: 0, rejected: 0 });
  });

  it('double admission is idempotent', () => {
    const pool = createLearningPool();
    pool.admit(manifest());
    const second = pool.admit(manifest());
    assert.equal(second.decision, 'duplicate');
    assert.deepEqual(pool.stats(), { positive: 1, failures: 0, rejected: 0 });
  });
});

describe('Phase 4: candidates never activate', () => {
  it('proposals carry traceability and change nothing', () => {
    const pool = createLearningPool();
    pool.admit(manifest());
    const res = pool.propose({ runId: 'run-1', sources: ['hash-abc'] });
    assert.equal(res.ok, true);
    assert.equal(res.candidate.status, 'candidate');
    assert.deepEqual(res.candidate.trace.sources, ['hash-abc']);
    assert.deepEqual(pool.stats(), { positive: 1, failures: 0, rejected: 0 });
  });

  it('failure records are never proposable', () => {
    const pool = createLearningPool();
    pool.admit(manifest({
      runId: 'run-9', outcomeStatus: 'failed', learningEligibility: 'negative_example',
    }));
    assert.deepEqual(pool.propose({ runId: 'run-9', sources: ['hash-abc'] }),
      { ok: false, code: 'failure_not_proposable' });
  });

  it('unknown runs are not proposable', () => {
    const pool = createLearningPool();
    assert.deepEqual(pool.propose({ runId: 'ghost', sources: ['hash-x'] }),
      { ok: false, code: 'not_in_positive_pool' });
  });
});
