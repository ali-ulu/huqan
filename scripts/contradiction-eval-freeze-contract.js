'use strict';

/**
 * R50 PR1 — the frozen contract behind the contradiction evaluation fixture
 * (issue #3582).
 *
 * Everything here is decided before any arm runs: the seed, the selection and
 * split rules, the sample-adequacy floor, the label vocabulary and the exact
 * shape of a corpus record. The values are constants rather than inputs because
 * a measurement that can be re-tuned after seeing its own result is not a
 * measurement.
 *
 * Two properties are worth stating where they are implemented:
 *
 * - Selection and splitting read identifiers and the seed only, never a label,
 *   so editing a label cannot move a pair between splits.
 * - Snapshot identity is its content set, not the order a file lists it in:
 *   candidates are ordered by `candidateId` before the digest.
 *
 * Nothing here reads the clock, the network or the file system, and nothing
 * here runs a contradiction detector: a fixture that carried detector output
 * could not be used to measure a detector.
 */

const { contentHash } = require('../lib/content-hash');

const DATASET_VERSION = 'contradiction-eval-v1';
const SOURCE_SNAPSHOT_SCHEMA_VERSION = 'huqan-contradiction-eval-source-snapshot-v1';
const SOURCE_LABELS_SCHEMA_VERSION = 'huqan-contradiction-eval-source-labels-v1';
const CORPUS_SCHEMA_VERSION = 'huqan-contradiction-eval-corpus-v1';
const LABELS_SCHEMA_VERSION = 'huqan-contradiction-eval-labels-v1';
const MANIFEST_SCHEMA_VERSION = 'huqan-contradiction-eval-manifest-v1';

// Frozen before the fixture existed; changing it is changing the measurement,
// so a caller cannot pass another one.
const FREEZE_SEED = 3582;
const SELECTION_RULE = 'sha256-keyed-selection-v1';
const SPLIT_RULE = 'sha256-group-bucket-v1';
const SPLIT_BUCKET_EDGES = Object.freeze({ train: 60, calibration: 80 });
const SPLITS = Object.freeze(['train', 'calibration', 'holdout']);
const STRATA = Object.freeze([
  'representative', 'lexical_opposition_only', 'scope_shift', 'measurement_uncertain', 'malformed_pair',
]);

const LABEL_VALUES = Object.freeze(['CONTRADICTION', 'NOT_CONTRADICTION', 'UNCERTAIN', 'INVALID_PAIR']);
const SCORABLE_LABELS = Object.freeze(['CONTRADICTION', 'NOT_CONTRADICTION']);

// Pre-declared sample adequacy, aligned with the Cognitive Lab calibration
// floor (lib/cognitive-lab-probability-calibration.js MIN_OBSERVED_RECORDS=10):
// a Brier score under ten observed decisions is not a measurement.
const MIN_SCORABLE_PER_SPLIT = Object.freeze({ train: 20, calibration: 10, holdout: 10 });

const CLAIM_FIELDS = Object.freeze(['text', 'subject', 'relation', 'sourceType', 'frameId']);
const CANDIDATE_FIELDS = Object.freeze([
  'candidateId', 'pairGroupId', 'triggerKind', 'samplingStratum', 'stored', 'incoming',
]);
const RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'pairId', 'pairDigest', 'pairGroupId', 'source', 'stored', 'incoming', 'split', 'samplingStratum',
]);
const SOURCE_FIELDS = Object.freeze(['system', 'candidateId', 'snapshotDigest', 'triggerKind']);

class FixtureError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'FixtureError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new FixtureError(code, message, detail);
}

/** Canonical JSON: recursively sorted keys, so field order cannot move a digest. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function digestOf(value) {
  return contentHash(stableStringify(value));
}

function pickClaim(claim = {}) {
  const picked = {};
  for (const field of CLAIM_FIELDS) picked[field] = String(claim[field] ?? '');
  return picked;
}

function pairDigestOf(candidate) {
  return `sha256:${digestOf({ stored: pickClaim(candidate.stored), incoming: pickClaim(candidate.incoming) })}`;
}

function pairIdOf(pairDigest) {
  return `pair:${pairDigest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

/**
 * Identity of a source snapshot is its content set, not the order a file
 * happened to list it in: candidates are ordered by `candidateId` before the
 * digest, so re-sorting the file cannot look like a changed source.
 */
function sourceSnapshotDigest(candidates = []) {
  const ordered = [...candidates].sort((left, right) => (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0));
  return `sha256:${digestOf(ordered)}`;
}

function selectionKeyFor(candidateId) {
  return digestOf(`${DATASET_VERSION}|select|${FREEZE_SEED}|${candidateId}`);
}

function splitBucketFor(pairGroupId) {
  return Number.parseInt(digestOf(`${DATASET_VERSION}|split|${FREEZE_SEED}|${pairGroupId}`).slice(0, 8), 16) % 100;
}

/** Label-blind: the bucket is a hash of the group id and the locked seed only. */
function assignSplit(pairGroupId) {
  const bucket = splitBucketFor(pairGroupId);
  if (bucket < SPLIT_BUCKET_EDGES.train) return 'train';
  if (bucket < SPLIT_BUCKET_EDGES.calibration) return 'calibration';
  return 'holdout';
}

function requireRecord(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
  return value;
}

function requireText(value, code, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(code, `${field} is required and must be a non-empty string`, { field });
  }
  return value.trim();
}

/** Strict allowlist: an extra key is a contract violation, not a widening. */
function requireExactFields(value, allowed, code, where) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(code, `${where} carries a field outside the contract`, { where, unknown });
  const missing = allowed.filter((key) => value[key] === undefined);
  if (missing.length > 0) fail(code, `${where} is missing a required field`, { where, missing });
}

function validateSourceSnapshot(snapshot) {
  requireRecord(snapshot, 'source_snapshot_invalid', 'source snapshot must be an object');
  if (snapshot.schemaVersion !== SOURCE_SNAPSHOT_SCHEMA_VERSION) {
    fail('source_snapshot_schema_mismatch', 'source snapshot schemaVersion is not the frozen one', {
      expected: SOURCE_SNAPSHOT_SCHEMA_VERSION, actual: snapshot.schemaVersion,
    });
  }
  const sourceSystem = requireText(snapshot.sourceSystem, 'source_snapshot_invalid', 'sourceSystem');
  const snapshotId = requireText(snapshot.snapshotId, 'source_snapshot_invalid', 'snapshotId');
  const targets = requireRecord(snapshot.selectionTargets, 'source_snapshot_invalid', 'selectionTargets is required');
  for (const stratum of STRATA) {
    if (targets[stratum] === undefined) {
      fail('source_snapshot_invalid', `selectionTargets.${stratum} must be declared`, { stratum });
    }
    if (!Number.isInteger(targets[stratum]) || targets[stratum] < 0) {
      fail('source_snapshot_invalid', `selectionTargets.${stratum} must be a non-negative integer`, { stratum });
    }
  }
  if (!Array.isArray(snapshot.candidates) || snapshot.candidates.length === 0) {
    fail('source_snapshot_invalid', 'candidates must be a non-empty array');
  }
  const seenIds = new Set();
  for (const candidate of snapshot.candidates) {
    requireRecord(candidate, 'source_snapshot_invalid', 'every candidate must be an object');
    requireExactFields(candidate, CANDIDATE_FIELDS, 'source_snapshot_invalid', 'candidate');
    const candidateId = requireText(candidate.candidateId, 'source_snapshot_invalid', 'candidateId');
    if (seenIds.has(candidateId)) fail('duplicate_candidate', `candidateId appears twice: ${candidateId}`, { candidateId });
    seenIds.add(candidateId);
    requireText(candidate.pairGroupId, 'source_snapshot_invalid', 'pairGroupId');
    requireText(candidate.triggerKind, 'source_snapshot_invalid', 'triggerKind');
    if (!STRATA.includes(candidate.samplingStratum)) {
      fail('source_snapshot_invalid', 'samplingStratum is not in the frozen vocabulary', {
        candidateId, samplingStratum: candidate.samplingStratum,
      });
    }
    for (const side of ['stored', 'incoming']) {
      requireRecord(candidate[side], 'source_snapshot_invalid', `${side} must be an object`);
      requireExactFields(candidate[side], CLAIM_FIELDS, 'source_snapshot_invalid', `${candidateId}.${side}`);
      requireText(candidate[side].text, 'source_snapshot_invalid', `${side}.text`);
    }
  }
  return { sourceSystem, snapshotId, targets, candidates: snapshot.candidates };
}

function validateSourceLabels(sourceLabels, knownCandidateIds) {
  requireRecord(sourceLabels, 'source_labels_invalid', 'source labels must be an object');
  if (sourceLabels.schemaVersion !== SOURCE_LABELS_SCHEMA_VERSION) {
    fail('source_labels_schema_mismatch', 'source labels schemaVersion is not the frozen one', {
      expected: SOURCE_LABELS_SCHEMA_VERSION, actual: sourceLabels.schemaVersion,
    });
  }
  requireRecord(sourceLabels.provenance, 'source_labels_invalid', 'provenance is required');
  const labels = requireRecord(sourceLabels.labels, 'source_labels_invalid', 'labels is required');
  for (const [candidateId, entry] of Object.entries(labels)) {
    if (!knownCandidateIds.has(candidateId)) {
      fail('label_unknown_candidate', `label for an unknown candidateId: ${candidateId}`, { candidateId });
    }
    requireRecord(entry, 'label_malformed', `label entry for ${candidateId} must be an object`, { candidateId });
    requireExactFields(entry, ['label', 'note'], 'label_malformed', `label(${candidateId})`);
    if (!LABEL_VALUES.includes(entry.label)) {
      fail('label_malformed', 'label value is not in the frozen vocabulary', { candidateId, label: entry.label });
    }
  }
  return labels;
}

module.exports = {
  DATASET_VERSION,
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
  SOURCE_LABELS_SCHEMA_VERSION,
  CORPUS_SCHEMA_VERSION,
  LABELS_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  FREEZE_SEED,
  SELECTION_RULE,
  SPLIT_RULE,
  SPLIT_BUCKET_EDGES,
  SPLITS,
  STRATA,
  LABEL_VALUES,
  SCORABLE_LABELS,
  MIN_SCORABLE_PER_SPLIT,
  CLAIM_FIELDS,
  CANDIDATE_FIELDS,
  RECORD_FIELDS,
  SOURCE_FIELDS,
  FixtureError,
  fail,
  stableStringify,
  digestOf,
  pickClaim,
  pairDigestOf,
  pairIdOf,
  sourceSnapshotDigest,
  selectionKeyFor,
  splitBucketFor,
  assignSplit,
  requireRecord,
  requireText,
  requireExactFields,
  validateSourceSnapshot,
  validateSourceLabels,
};
