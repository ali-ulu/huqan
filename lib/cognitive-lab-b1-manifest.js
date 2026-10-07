'use strict';

/**
 * Cognitive Lab B1 candidate-measurement manifest builder (#3562, I6c R19).
 *
 * The B1 baseline replay runner (cognitive-lab-b1-replay.js) consumes a frozen
 * `{manifest, manifestDigest, experiment}` triple, but no production code
 * reported the manifest `mechanisms` label for B1: every manifest with a
 * mechanisms block came from another mechanism's runner (B2/B3 causal, B5
 * world-model, B7 neural). This module is that missing B1 side. It builds the
 * triple with the label fixed to `{B1: ENABLED, rest: NOT_MEASURED}` --
 * reported independently of the B7 runner, which this module never imports.
 *
 * No runner, no store, no promotion: like the replay runner it composes, the
 * output is a candidate measurement input, never canonical knowledge. The
 * caller supplies the frozen fixture digest and the split; the builder
 * freezes, digests and labels, and refuses malformed inputs with a typed
 * error instead of inventing defaults.
 */

const { isPlainObject } = require('./is-plain-object');
const { contentHash } = require('./content-hash');
const { buildManifest } = require('./cognitive-lab-manifest');

const B1_MEASUREMENT_VERSION = 'belief-revision-b1-v1';
const HEX_64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

function mechanismsLabel() {
  return Object.freeze({
    B1: 'ENABLED',
    B2: 'NOT_MEASURED',
    B3: 'NOT_MEASURED',
    B4: 'NOT_MEASURED',
    B5: 'NOT_MEASURED',
    B6: 'NOT_MEASURED',
    B7: 'NOT_MEASURED',
    B8: 'NOT_MEASURED',
  });
}

function idList(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TypeError(`${field} must be a list of non-empty string ids`);
  }
  return Object.freeze([...value]);
}

function boundedString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function hexDigest(value, field) {
  if (typeof value !== 'string' || !HEX_64.test(value)) throw new TypeError(`${field} must be a 64 char lowercase hex digest`);
  return value;
}

/**
 * Build the frozen `{manifest, manifestDigest, experiment}` triple a B1
 * baseline replay runs under. The mechanisms label is fixed by this module,
 * never taken from the caller, so a B1 measurement cannot be relabelled by
 * the input that requests it.
 */
function buildB1Experiment(input = {}) {
  if (!isPlainObject(input)) throw new TypeError('input must be an object');
  const split = isPlainObject(input.split) ? input.split : null;
  if (!split) throw new TypeError('split with train, holdout and transfer id lists is required');
  const train = idList(split.train, 'split.train');
  const holdout = idList(split.holdout, 'split.holdout');
  const transfer = idList(split.transfer, 'split.transfer');
  if (!Number.isInteger(input.seed) || input.seed < 0) throw new TypeError('seed must be a non-negative integer');
  if (!Number.isInteger(input.budgetModelCalls) || input.budgetModelCalls < 1) {
    throw new TypeError('budgetModelCalls must be a positive integer');
  }
  const source = isPlainObject(input.source) ? input.source : null;
  if (!source) throw new TypeError('source with repository, commit and dirty is required');
  boundedString(source.repository, 'source.repository');
  if (typeof source.commit !== 'string' || !COMMIT.test(source.commit)) {
    throw new TypeError('source.commit must be a 7-64 char lowercase hex commit');
  }
  if (typeof source.dirty !== 'boolean') throw new TypeError('source.dirty must be an explicit boolean');
  const outcomes = isPlainObject(input.outcomes) ? input.outcomes : null;
  if (!outcomes) throw new TypeError('outcomes map is required');
  const observations = isPlainObject(input.observations) ? input.observations : null;
  if (!observations) throw new TypeError('observations map is required');
  const recordedAt = boundedString(input.recordedAt, 'recordedAt');
  const outcomeAt = boundedString(input.outcomeAt, 'outcomeAt');
  const frame = isPlainObject(input.frame) ? input.frame : {};
  const splitIdentity = contentHash(JSON.stringify({
    train: [...train].sort(), holdout: [...holdout].sort(), transfer: [...transfer].sort(),
  }));
  const mechanisms = mechanismsLabel();
  const manifestInput = {
    schemaVersion: 'huqan-cognitive-lab-manifest-v1',
    source: { repository: source.repository, commit: source.commit, dirty: source.dirty },
    fixture: { digest: hexDigest(input.fixtureDigest, 'fixtureDigest') },
    split: { identity: splitIdentity, train: [...train], holdout: [...holdout], transfer: [...transfer] },
    frame: {
      repository: frame.repository || 'ali-ulu/huqan',
      branch: frame.branch || 'main',
      environment: frame.environment || 'offline',
      task: frame.task || 'R19-B1',
    },
    seed: input.seed,
    mechanisms: { ...mechanisms },
    budget: {
      modelCalls: input.budgetModelCalls,
      toolCalls: 0,
      humanCalls: 0,
      tokens: null,
      wallTimeMs: null,
      compute: null,
    },
    measurementVersion: typeof input.measurementVersion === 'string' && input.measurementVersion.trim() !== ''
      ? input.measurementVersion
      : B1_MEASUREMENT_VERSION,
    thresholdConfigHash: hexDigest(input.thresholdConfigHash, 'thresholdConfigHash'),
  };
  const built = buildManifest(manifestInput);
  const experiment = Object.freeze({
    benchmark: 'B1',
    split: Object.freeze({ train, holdout, transfer }),
    budget: Object.freeze({ modelCalls: input.budgetModelCalls }),
    mechanisms,
    outcomes: Object.freeze({ ...outcomes }),
    observations: Object.freeze({ ...observations }),
    recordedAt,
    outcomeAt,
  });
  return Object.freeze({ manifest: built.manifest, manifestDigest: built.digest, experiment });
}

module.exports = Object.freeze({
  B1_MEASUREMENT_VERSION,
  buildB1Experiment,
  mechanismsLabel,
});
