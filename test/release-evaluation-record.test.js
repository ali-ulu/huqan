'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EVALUATION_RECORD_VERSION,
  buildReleaseEvaluationRecord,
  verifyReleaseEvaluationRecord,
} = require('../lib/release-evaluation-record');

const DIGEST = 'e'.repeat(64);
const SHA = 'a'.repeat(40);

function input(overrides = {}) {
  return {
    releaseSha: SHA,
    suiteDigests: { unit: DIGEST, fixtures: DIGEST },
    evaluator: 'evaluator:codex',
    environment: 'ci-ubuntu-node22',
    passCount: 120,
    failCount: 0,
    criticalFindings: [],
    acceptedRisk: 'no critical findings; shard flake watch stays on',
    expiresAt: '2026-12-31T00:00:00.000Z',
    ...overrides,
  };
}

test('a complete record builds, binds and verifies', () => {
  const record = buildReleaseEvaluationRecord(input());
  assert.equal(record.version, EVALUATION_RECORD_VERSION);
  assert.match(record.recordId, /^release-eval:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(record));
  const verified = verifyReleaseEvaluationRecord(record, { now: '2026-06-01T00:00:00.000Z' });
  assert.deepEqual(verified, { valid: true, failed: false, reason: null });
});

test('recorded failures verify as records that block publication', () => {
  const record = buildReleaseEvaluationRecord(input({ failCount: 2, criticalFindings: ['shard-2 hang'] }));
  const verified = verifyReleaseEvaluationRecord(record, { now: '2026-06-01T00:00:00.000Z' });
  assert.equal(verified.valid, true);
  assert.equal(verified.failed, true);
  assert.equal(verified.reason, 'recorded_failures_present');
});

test('edits break the binding and expiry invalidates', () => {
  const record = buildReleaseEvaluationRecord(input());
  assert.deepEqual(
    verifyReleaseEvaluationRecord({ ...record, passCount: 999 }, { now: '2026-06-01T00:00:00.000Z' }).reason,
    'binding_mismatch',
  );
  assert.deepEqual(
    verifyReleaseEvaluationRecord(record, { now: '2027-01-01T00:00:00.000Z' }).reason,
    'record_expired',
  );
  assert.deepEqual(verifyReleaseEvaluationRecord(null).reason, 'record_malformed');
});

test('incomplete records never build', () => {
  for (const bad of [
    {},
    input({ releaseSha: 'xyz' }),
    input({ suiteDigests: {} }),
    input({ suiteDigests: { unit: 'not-hex' } }),
    input({ evaluator: '   ' }),
    input({ passCount: -1 }),
    input({ expiresAt: 'someday' }),
    input({ acceptedRisk: '' }),
  ]) {
    assert.throws(() => buildReleaseEvaluationRecord(bad), /required|hex|digest|integer|instant|object|empty/i);
  }
});
