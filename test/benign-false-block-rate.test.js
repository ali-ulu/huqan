'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  measureBenignFalseBlockRate,
  BASELINE,
  READ_ONLY,
  WORKFLOW,
} = require('../scripts/benign-false-block-rate');

test('no read-only action needs a human', () => {
  // Reading state, listing files, asking a tool its version. If the guard
  // charges for one of these it is charging for something it cannot justify,
  // so these are held individually rather than only in the aggregate -- an
  // average can absorb a regression here, and this is the tier where a
  // regression is unambiguously wrong.
  const { readOnly } = measureBenignFalseBlockRate();
  const stopped = readOnly.filter((entry) => entry.stopped);
  assert.deepEqual(stopped.map((entry) => entry.command), [],
    'a read-only action now needs a human');
});

test('the benign stop rate has not risen above the recorded baseline', () => {
  // A ratchet, not a target. The rate is not asserted to be good -- 38.9% is
  // not good -- it is asserted to be visible and to not get worse silently.
  const report = measureBenignFalseBlockRate();
  assert.ok(report.rate <= BASELINE.overallReviewedRate,
    `benign stop rate rose to ${(report.rate * 100).toFixed(1)}% from `
    + `${(BASELINE.overallReviewedRate * 100).toFixed(1)}%. That may be a deliberate `
    + 'policy tightening, but it is a cost nobody would otherwise see: update '
    + 'BASELINE with the reason, or loosen the policy.');
});

test('the measured rate matches what the baseline records', () => {
  // The baseline is a claim about the current policy, so it is checked rather
  // than trusted. A baseline drifting quietly below the real rate would make
  // the ratchet above pass while measuring nothing.
  const report = measureBenignFalseBlockRate();
  assert.equal(report.total, READ_ONLY.length + WORKFLOW.length);
  assert.equal(report.rate, BASELINE.overallReviewedRate,
    'the recorded baseline no longer matches the measurement; it is stale in one direction or the other');
});

test('the corpus runs through the real decision path', () => {
  // The whole value of the number is that nothing is mocked. If this ever
  // measured a stub, it would report a comfortable rate that means nothing.
  const report = measureBenignFalseBlockRate();
  for (const entry of [...report.readOnly, ...report.workflow]) {
    assert.ok(['allow', 'review', 'block'].includes(entry.decision),
      `${entry.command} produced no real verdict: ${entry.decision}`);
  }
});

test('the corpus is large enough for the rate to mean anything', () => {
  // A three-case corpus moves 33 points per case and would make the ratchet
  // noise. This is not a large sample either, but it is enough that one
  // reclassification does not swamp it.
  assert.ok(READ_ONLY.length >= 10, 'read-only tier too small to detect a regression');
  assert.ok(WORKFLOW.length >= 5, 'workflow tier too small to detect a regression');
});

test('a stopped action counts whether it is blocked or merely reviewed', () => {
  // From the perspective of someone trying to get work done these are the same
  // event: the action does not run without a human. Counting only `block`
  // would report this guard as costing nothing, since it currently blocks no
  // benign action at all -- every one of its costs is spelled `review`.
  const report = measureBenignFalseBlockRate();
  const stopped = [...report.readOnly, ...report.workflow].filter((entry) => entry.stopped);
  assert.ok(stopped.length > 0, 'nothing stopped: the measurement is not reaching the policy');
  assert.ok(stopped.every((entry) => entry.decision === 'review' || entry.decision === 'block'));
});
