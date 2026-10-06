'use strict';

/**
 * I7: grounded transfer check over K1 reference frames (#3475, Roadmap R20).
 *
 * K0 (#3470) fixed what the kernel knows and K1 (#3471) fixed where one
 * cognitive step is true; R49 (#3568) put the first real producer on both.
 * What is still missing -- the verification note on #3475 says it plainly:
 * "Grounded intelligence yok." No sensor reading in this repo is bound to the
 * frame it was observed in, so a finding can travel to a context it was never
 * measured in without anyone noticing.
 *
 * This module is the bounded, candidate-only slice of that gap. It binds one
 * sensor reading to its K1 reference frame, projects a deterministic
 * world-state record from frame-bound observations, derives a structural
 * latent of fixed geometry from that record, and answers the one question
 * #3475 accepts before anything else is measured: may this observation be
 * reused in another frame?
 *
 * Three deliberate non-goals, all from the plan
 * (`docs/reports/language-math-requirements-20261001.md`, I7 row;
 * `docs/reports/development-plan-20261001.md`, I7 row):
 *
 * - No learned predictor. The structural latent is a hash-derived unit vector
 *   of fixed dimension: geometry the transfer math can be characterized on,
 *   not a JEPA, not a world model, and never presented as one. A trained
 *   latent/sensorimotor model waits for the P0/P1 measurements.
 * - No transfer-gain claim without those measurements. When the frames match
 *   but `p0p1Measured` is false, the verdict is INSUFFICIENT with reason
 *   `P0P1_NOT_MEASURED` -- the issue's acceptance gate, enforced in code.
 * - No promotion, ever. Every verdict carries
 *   `promotion: 'NONE_CANDIDATE_ONLY'`: a transfer check characterizes a
 *   candidate reuse, it never admits knowledge, writes a procedure, or merges
 *   frames. A frame mismatch or an unresolved frame asks for review through
 *   K1's own comparator (`requiresReview`), never a silent merge.
 *
 * Stale support is checked, not assumed: an observation carries its frame
 * time, and `checkSupportFreshness` reports FRESH, STALE, or INDETERMINATE
 * against an explicit age bound. A stale observation is not false -- it is
 * flagged for re-observation before reuse.
 *
 * Fail-closed throughout: an invalid frame, a non-lossless reading, or an
 * empty observation set throws `GROUNDING_CONTRACT_VIOLATION` with the
 * offending fields, so a bad candidate never reaches a queue.
 */

const { contentHash } = require('./content-hash');
const {
  compareReferenceFrames,
  FRAME_COMPARISON_STATUS,
  validateReferenceFrame,
} = require('./memory-cognitive-message');
const { isLosslessJson } = require('./memory-schema-checks');

const GROUNDING_CONTRACT_VIOLATION = 'GROUNDING_CONTRACT_VIOLATION';
const GROUNDED_OBSERVATION_TYPE = 'grounded-sensor-observation';
const GROUNDED_WORLD_STATE_TYPE = 'grounded-world-state';
const STRUCTURAL_LATENT_DIMENSIONS = 8;

const TRANSFER_STATUS = Object.freeze({
  MATCH_MEASURED: 'match_measured',
  REQUIRES_REVIEW: 'requires_review',
  INSUFFICIENT: 'insufficient',
});

const TRANSFER_REASONS = Object.freeze({
  FRAME_MISMATCH: 'FRAME_MISMATCH',
  FRAME_UNKNOWN: 'FRAME_UNKNOWN',
  P0P1_NOT_MEASURED: 'P0P1_NOT_MEASURED',
  AGREEMENT_MEASURED: 'AGREEMENT_MEASURED',
});

const SUPPORT_STATUS = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  INDETERMINATE: 'indeterminate',
});

function violation(message, field) {
  const error = new TypeError(`[memory-grounded-transfer] ${message}`);
  error.code = GROUNDING_CONTRACT_VIOLATION;
  error.field = field;
  throw error;
}

// Deterministic serialization: JSON with recursively sorted object keys, so
// the same reading always digests identically regardless of key insertion
// order. Only lossless-JSON values reach this function (checked at admission).
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  const entries = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function frameDigest(frame) {
  return contentHash(stableStringify(frame));
}

/**
 * Bind one sensor reading to the K1 reference frame it was observed in.
 * The reading must survive JSON unchanged (K0/K1 lossless rule); the frame
 * must validate through K1. Returns a frozen observation carrying both plus
 * the digests that later stages join on.
 */
function observeSensorReading({ sensorId, reading, frame }) {
  if (typeof sensorId !== 'string' || sensorId.trim() === '') {
    violation('sensorId must be a non-blank string', 'sensorId');
  }
  if (!isLosslessJson(reading)) {
    violation('reading must be lossless JSON so its digest is exact', 'reading');
  }
  const frameReport = validateReferenceFrame(frame);
  if (!frameReport.ok) {
    violation(`reference frame is invalid: ${frameReport.errors.map(entry => entry.message).join('; ')}`, 'frame');
  }
  const frozenFrame = Object.freeze({ ...frame });
  return Object.freeze({
    type: GROUNDED_OBSERVATION_TYPE,
    sensorId: sensorId.trim(),
    readingDigest: contentHash(stableStringify(reading)),
    frameDigest: frameDigest(frozenFrame),
    frame: frozenFrame,
    observedAt: frozenFrame.time,
  });
}

/**
 * Deterministic world-state projection: group frame-bound observations by
 * the frame they were observed in. No learning, no prediction -- the record
 * says which observations share a ground, so a later stage can refuse to
 * mix grounds silently.
 */
function projectWorldState({ observations }) {
  if (!Array.isArray(observations) || observations.length === 0) {
    violation('observations must be a non-empty array', 'observations');
  }
  for (const observation of observations) {
    if (!observation || observation.type !== GROUNDED_OBSERVATION_TYPE
      || typeof observation.frameDigest !== 'string'
      || typeof observation.readingDigest !== 'string') {
      violation('every observation must be built by observeSensorReading', 'observations');
    }
  }
  const byFrame = new Map();
  for (const observation of observations) {
    const group = byFrame.get(observation.frameDigest);
    if (group) group.push(observation.readingDigest);
    else byFrame.set(observation.frameDigest, [observation.readingDigest]);
  }
  const states = [...byFrame.entries()].map(([digest, digests]) => Object.freeze({
    frameDigest: digest,
    frame: observations.find(entry => entry.frameDigest === digest).frame,
    observationDigests: Object.freeze([...digests].sort()),
  }));
  states.sort((left, right) => (left.frameDigest < right.frameDigest ? -1 : 1));
  return Object.freeze({
    type: GROUNDED_WORLD_STATE_TYPE,
    observationCount: observations.length,
    stateCount: states.length,
    stateDigest: contentHash(stableStringify(states.map(state => ({
      frameDigest: state.frameDigest,
      observationDigests: state.observationDigests,
    })))),
    states: Object.freeze(states),
  });
}

/**
 * Structural latent: a fixed-geometry unit vector derived from the
 * world-state digest. Deterministic in, deterministic out -- the same state
 * always yields the same latent, so agreement between two latents is a pure
 * function of the underlying states.
 *
 * This is explicitly NOT a learned representation and NOT a JEPA: no
 * predictor, no training, no generalization claim. It exists so the transfer
 * machinery (frame comparison, agreement scoring, review gating) can be
 * characterized on real geometry before P0/P1 measurements justify learning
 * one.
 */
function projectStructuralLatent({ worldState, dimensions = STRUCTURAL_LATENT_DIMENSIONS }) {
  if (!worldState || worldState.type !== GROUNDED_WORLD_STATE_TYPE
    || typeof worldState.stateDigest !== 'string') {
    violation('worldState must be built by projectWorldState', 'worldState');
  }
  if (!Number.isInteger(dimensions) || dimensions < 2 || dimensions > 64) {
    violation('dimensions must be an integer in [2, 64]', 'dimensions');
  }
  const components = [];
  let counter = 0;
  while (components.length < dimensions) {
    const digest = contentHash(`${worldState.stateDigest}:${counter}`);
    for (let index = 0; index < digest.length && components.length < dimensions; index += 2) {
      components.push(parseInt(digest.slice(index, index + 2), 16) / 255);
    }
    counter += 1;
  }
  const norm = Math.sqrt(components.reduce((total, value) => total + value * value, 0));
  const vector = components.map(value => (norm === 0 ? 0 : value / norm));
  return Object.freeze({
    kind: 'structural',
    learned: false,
    dimensions,
    vector: Object.freeze(vector),
    stateDigest: worldState.stateDigest,
  });
}

function latentAgreement(left, right) {
  if (left.dimensions !== right.dimensions) return 0;
  return left.vector.reduce((total, value, index) => total + value * right.vector[index], 0);
}

/**
 * Stale-support check against an explicit age bound. A stale observation is
 * not wrong -- support decays, so reuse asks for re-observation first.
 * Without a parseable observation time or bound the answer is INDETERMINATE,
 * never "fresh by default".
 */
function checkSupportFreshness({ observation, nowIso, maxAgeMs }) {
  if (!observation || observation.type !== GROUNDED_OBSERVATION_TYPE) {
    violation('observation must be built by observeSensorReading', 'observation');
  }
  const observedMs = Date.parse(observation.observedAt);
  const nowMs = Date.parse(nowIso);
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || Number.isNaN(observedMs) || Number.isNaN(nowMs)) {
    return Object.freeze({ status: SUPPORT_STATUS.INDETERMINATE, reason: 'observation time or age bound is not decidable' });
  }
  if (nowMs - observedMs <= maxAgeMs) {
    return Object.freeze({ status: SUPPORT_STATUS.FRESH, reason: 'observation is within the declared age bound' });
  }
  return Object.freeze({ status: SUPPORT_STATUS.STALE, reason: 'observation is older than the declared age bound; re-observe before reuse' });
}

/**
 * The I7 acceptance question: may `candidate` (observation, world-state, or
 * structural latent carrying its frame) be reused in `targetFrame`?
 *
 * - Frame mismatch or an undecidable frame: REQUIRES_REVIEW. K1's comparator
 *   decides; this function only carries its verdict, with merging refused.
 * - Frames match but the P0/P1 mechanisms are not measured yet:
 *   INSUFFICIENT with reason P0P1_NOT_MEASURED. This is the issue's gate in
 *   code: no agreement score is reported as a gain until the mechanisms
 *   behind it are measured (#3562).
 * - Frames match and P0/P1 are measured: comparison is meaningful, reported as
 *   MATCH_MEASURED with no numeric gain claimed here. The numeric
 *   characterization belongs to scoreMeasuredAgreement (both sides through
 *   the same deterministic pipeline). Candidate-only either way: never a
 *   promotion, never a merge, never a learning claim.
 */
function checkGroundedTransfer({ candidate, targetFrame, p0p1Measured = false }) {
  if (!candidate || typeof candidate.frame === 'undefined' || candidate.frame === null) {
    violation('candidate must carry the frame it was observed in', 'candidate');
  }
  const frameReport = validateReferenceFrame(targetFrame);
  if (!frameReport.ok) {
    violation(`target frame is invalid: ${frameReport.errors.map(entry => entry.message).join('; ')}`, 'targetFrame');
  }
  const comparison = compareReferenceFrames(targetFrame, candidate.frame);
  const base = {
    frameComparison: comparison.status,
    frameComparisonCode: comparison.code,
    mismatched: comparison.mismatched,
    unresolved: comparison.unresolved,
    requiresReview: true,
    mergeAllowed: false,
    promotion: 'NONE_CANDIDATE_ONLY',
  };
  if (comparison.status !== FRAME_COMPARISON_STATUS.MATCH) {
    const reason = comparison.status === FRAME_COMPARISON_STATUS.MISMATCH
      ? TRANSFER_REASONS.FRAME_MISMATCH
      : TRANSFER_REASONS.FRAME_UNKNOWN;
    return Object.freeze({
      ...base,
      status: TRANSFER_STATUS.REQUIRES_REVIEW,
      reason,
      transferGain: 'INSUFFICIENT',
    });
  }
  if (p0p1Measured !== true) {
    return Object.freeze({
      ...base,
      status: TRANSFER_STATUS.INSUFFICIENT,
      reason: TRANSFER_REASONS.P0P1_NOT_MEASURED,
      transferGain: 'INSUFFICIENT',
    });
  }
  // Frames match and the P0/P1 mechanisms are measured: a measured comparison
  // is meaningful. The gate itself still claims no numeric gain -- that
  // characterization belongs to scoreMeasuredAgreement, which projects both
  // sides through the same deterministic pipeline. Candidate-only throughout.
  return Object.freeze({
    ...base,
    requiresReview: false,
    mergeAllowed: comparison.mergeAllowed,
    status: TRANSFER_STATUS.MATCH_MEASURED,
    reason: TRANSFER_REASONS.AGREEMENT_MEASURED,
    transferGain: null,
  });
}

/**
 * Convenience for the measured path: project both sides through the same
 * deterministic pipeline and score their structural agreement. Still
 * candidate-only: the score characterizes reuse, it never authorizes it.
 */
function scoreMeasuredAgreement({ sourceObservations, targetObservations }) {
  const sourceState = projectWorldState({ observations: sourceObservations });
  const targetState = projectWorldState({ observations: targetObservations });
  const sourceLatent = projectStructuralLatent({ worldState: sourceState });
  const targetLatent = projectStructuralLatent({ worldState: targetState });
  return Object.freeze({
    agreement: latentAgreement(sourceLatent, targetLatent),
    sameGround: sourceState.stateDigest === targetState.stateDigest,
    promotion: 'NONE_CANDIDATE_ONLY',
  });
}

module.exports = Object.freeze({
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
});
