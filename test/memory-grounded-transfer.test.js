'use strict';

/**
 * Characterisation tests for the I7 grounded transfer check (#3475, R20).
 *
 * Pinned here: a sensor reading is bound to the K1 frame it was observed in
 * (fail-closed on a bad frame or a non-lossless reading); world-state
 * projection groups observations by ground without learning anything; the
 * structural latent is deterministic, fixed-geometry, and explicitly not
 * learned; a frame mismatch or an undecidable frame asks for review and never
 * merges; without measured P0/P1 mechanisms the verdict is INSUFFICIENT even
 * when the frames match; stale support asks for re-observation; and no path
 * in this module promotes, merges, or learns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GROUNDING_CONTRACT_VIOLATION,
  GROUNDED_OBSERVATION_TYPE,
  GROUNDED_WORLD_STATE_TYPE,
  STRUCTURAL_LATENT_DIMENSIONS,
  SUPPORT_STATUS,
  TRANSFER_REASONS,
  TRANSFER_STATUS,
  checkGroundedTransfer,
  checkSupportFreshness,
  latentAgreement,
  observeSensorReading,
  projectStructuralLatent,
  projectWorldState,
  scoreMeasuredAgreement,
} = require('../lib/memory-grounded-transfer');

const NOW = '2026-10-06T12:00:00.000Z';

function frame(overrides = {}) {
  return {
    repo: 'ali-ulu/huqan',
    branch: 'main',
    commit: '5bff2104b2ffad092e475b7653573806535738061',
    environment: 'local',
    actor: 'operator',
    time: NOW,
    goal: 'characterize grounded reuse',
    task: 'i7-transfer-check',
    ...overrides,
  };
}

function observation(overrides = {}) {
  return observeSensorReading({
    sensorId: 'file-effect',
    reading: { path: 'lib/graph.js', effect: 'modified' },
    frame: frame(),
    ...overrides,
  });
}

test('a reading is bound to its frame with stable digests', () => {
  const first = observation();
  const second = observation();
  assert.equal(first.type, GROUNDED_OBSERVATION_TYPE);
  assert.equal(first.readingDigest, second.readingDigest);
  assert.equal(first.frameDigest, second.frameDigest);
  assert.deepEqual(first.frame, frame());
  assert.equal(first.observedAt, NOW);
  assert.ok(Object.isFrozen(first));
});

test('key order does not change the reading digest', () => {
  const first = observation({ reading: { a: 1, b: 2 } });
  const second = observation({ reading: { b: 2, a: 1 } });
  assert.equal(first.readingDigest, second.readingDigest);
});

test('an invalid frame fails closed with the violation code', () => {
  assert.throws(
    () => observation({ frame: { repo: 'ali-ulu/huqan' } }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && /reference frame is invalid/.test(error.message),
  );
});

test('a non-lossless reading fails closed instead of digesting approximately', () => {
  assert.throws(
    () => observation({ reading: { value: Number.NaN } }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'reading',
  );
  const sparse = [];
  sparse[2] = 'hole reads as null in JSON';
  assert.throws(
    () => observation({ reading: sparse }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION,
  );
});

test('a blank sensor id fails closed', () => {
  assert.throws(
    () => observation({ sensorId: '  ' }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'sensorId',
  );
});

test('world-state projection groups observations by ground', () => {
  const sameFrame = [observation(), observation({ reading: { path: 'lib/other.js', effect: 'unchanged' } })];
  const otherFrame = observation({ frame: frame({ branch: 'fix/3475-i7-grounded-frames' }) });
  const state = projectWorldState({ observations: [...sameFrame, otherFrame] });
  assert.equal(state.type, GROUNDED_WORLD_STATE_TYPE);
  assert.equal(state.observationCount, 3);
  assert.equal(state.stateCount, 2);
  assert.equal(state.states.length, 2);
  for (const entry of state.states) {
    assert.ok(typeof entry.frameDigest === 'string');
    assert.ok(Array.isArray(entry.observationDigests));
  }
  assert.ok(Object.isFrozen(state));
});

test('world-state projection refuses foreign or empty input', () => {
  assert.throws(
    () => projectWorldState({ observations: [] }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION,
  );
  assert.throws(
    () => projectWorldState({ observations: [{ type: 'not-an-observation' }] }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'observations',
  );
});

test('the structural latent is deterministic, normalized, and not learned', () => {
  const state = projectWorldState({ observations: [observation()] });
  const first = projectStructuralLatent({ worldState: state });
  const second = projectStructuralLatent({ worldState: state });
  assert.equal(first.learned, false);
  assert.equal(first.kind, 'structural');
  assert.equal(first.dimensions, STRUCTURAL_LATENT_DIMENSIONS);
  assert.equal(first.vector.length, STRUCTURAL_LATENT_DIMENSIONS);
  assert.deepEqual(first.vector, second.vector);
  const norm = Math.sqrt(first.vector.reduce((total, value) => total + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-12);
  assert.equal(first.stateDigest, state.stateDigest);
});

test('different grounds yield different latents', () => {
  const left = projectWorldState({ observations: [observation()] });
  const right = projectWorldState({ observations: [observation({ frame: frame({ branch: 'other' }) })] });
  const leftLatent = projectStructuralLatent({ worldState: left });
  const rightLatent = projectStructuralLatent({ worldState: right });
  assert.notDeepEqual(leftLatent.vector, rightLatent.vector);
  assert.ok(latentAgreement(leftLatent, rightLatent) < 1);
  assert.ok(Math.abs(latentAgreement(leftLatent, leftLatent) - 1) < 1e-12);
});

test('the latent refuses foreign input and bad dimensions', () => {
  const state = projectWorldState({ observations: [observation()] });
  assert.throws(
    () => projectStructuralLatent({ worldState: { type: 'not-a-world-state' } }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'worldState',
  );
  assert.throws(
    () => projectStructuralLatent({ worldState: state, dimensions: 1 }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'dimensions',
  );
});

test('a frame mismatch asks for review and refuses the merge', () => {
  const candidate = observation();
  const verdict = checkGroundedTransfer({
    candidate,
    targetFrame: frame({ branch: 'fix/3475-i7-grounded-frames' }),
  });
  assert.equal(verdict.status, TRANSFER_STATUS.REQUIRES_REVIEW);
  assert.equal(verdict.reason, TRANSFER_REASONS.FRAME_MISMATCH);
  assert.equal(verdict.frameComparison, 'mismatch');
  assert.deepEqual(verdict.mismatched, ['branch']);
  assert.equal(verdict.requiresReview, true);
  assert.equal(verdict.mergeAllowed, false);
  assert.equal(verdict.transferGain, 'INSUFFICIENT');
  assert.equal(verdict.promotion, 'NONE_CANDIDATE_ONLY');
});

test('matching frames without measured P0/P1 stay INSUFFICIENT', () => {
  const candidate = observation();
  const verdict = checkGroundedTransfer({ candidate, targetFrame: frame() });
  assert.equal(verdict.status, TRANSFER_STATUS.INSUFFICIENT);
  assert.equal(verdict.reason, TRANSFER_REASONS.P0P1_NOT_MEASURED);
  assert.equal(verdict.frameComparison, 'match');
  assert.equal(verdict.requiresReview, true);
  assert.equal(verdict.mergeAllowed, false);
  assert.equal(verdict.transferGain, 'INSUFFICIENT');
  assert.equal(verdict.promotion, 'NONE_CANDIDATE_ONLY');
});

test('matching frames with measured P0/P1 clear the gate but claim no gain', () => {
  const candidate = observation();
  const verdict = checkGroundedTransfer({ candidate, targetFrame: frame(), p0p1Measured: true });
  assert.equal(verdict.status, TRANSFER_STATUS.MATCH_MEASURED);
  assert.equal(verdict.reason, TRANSFER_REASONS.AGREEMENT_MEASURED);
  assert.equal(verdict.requiresReview, false);
  assert.equal(verdict.mergeAllowed, false);
  assert.equal(verdict.transferGain, null);
  assert.equal(verdict.promotion, 'NONE_CANDIDATE_ONLY');
});

test('a declared-unknown frame never reads as a match', () => {
  const candidate = observation();
  const verdict = checkGroundedTransfer({
    candidate,
    targetFrame: frame({ commit: 'unknown' }),
    p0p1Measured: true,
  });
  assert.equal(verdict.status, TRANSFER_STATUS.REQUIRES_REVIEW);
  assert.equal(verdict.reason, TRANSFER_REASONS.FRAME_MISMATCH);
  assert.equal(verdict.mergeAllowed, false);
});

test('the transfer check fails closed on bad input', () => {
  assert.throws(
    () => checkGroundedTransfer({ candidate: { noFrame: true }, targetFrame: frame() }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'candidate',
  );
  assert.throws(
    () => checkGroundedTransfer({ candidate: observation(), targetFrame: { repo: 'x' } }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'targetFrame',
  );
});

test('world-states and latents are not routable as transfer candidates', () => {
  const state = projectWorldState({ observations: [observation()] });
  assert.throws(
    () => checkGroundedTransfer({ candidate: state, targetFrame: frame(), p0p1Measured: true }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'candidate',
  );
  const latent = projectStructuralLatent({ worldState: state });
  assert.throws(
    () => checkGroundedTransfer({ candidate: latent, targetFrame: frame(), p0p1Measured: true }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'candidate',
  );
});

test('extra frame properties neither persist nor skew the digest', () => {
  const plain = observation();
  const extra = observation({ frame: frame({ sessionWidget: { mutable: true } }) });
  assert.deepEqual(Object.keys(extra.frame).sort(), Object.keys(frame()).sort());
  assert.equal(extra.frameDigest, plain.frameDigest);
});

test('freshness reports fresh, stale, and indeterminate honestly', () => {
  const candidate = observation();
  const fresh = checkSupportFreshness({
    observation: candidate,
    nowIso: '2026-10-06T12:00:00.500Z',
    maxAgeMs: 1000,
  });
  assert.equal(fresh.status, SUPPORT_STATUS.FRESH);
  const stale = checkSupportFreshness({
    observation: candidate,
    nowIso: '2026-10-06T12:00:05.000Z',
    maxAgeMs: 1000,
  });
  assert.equal(stale.status, SUPPORT_STATUS.STALE);
  assert.match(stale.reason, /re-observe/);
  const indeterminate = checkSupportFreshness({
    observation: candidate,
    nowIso: 'not-a-time',
    maxAgeMs: 1000,
  });
  assert.equal(indeterminate.status, SUPPORT_STATUS.INDETERMINATE);
});

test('freshness refuses foreign observations', () => {
  assert.throws(
    () => checkSupportFreshness({ observation: { type: 'x' }, nowIso: NOW, maxAgeMs: 1 }),
    error => error.code === GROUNDING_CONTRACT_VIOLATION && error.field === 'observation',
  );
});

test('measured agreement is symmetric and candidate-only', () => {
  const readings = [observation(), observation({ reading: { path: 'lib/other.js', effect: 'created' } })];
  const same = scoreMeasuredAgreement({ sourceObservations: readings, targetObservations: readings });
  assert.equal(same.agreement, 1);
  assert.equal(same.sameGround, true);
  assert.equal(same.promotion, 'NONE_CANDIDATE_ONLY');
  const other = scoreMeasuredAgreement({
    sourceObservations: readings,
    targetObservations: [observation({ frame: frame({ branch: 'elsewhere' }) })],
  });
  assert.ok(other.agreement < 1);
  assert.equal(other.sameGround, false);
  assert.ok(other.agreement >= -1 && other.agreement <= 1);
});
