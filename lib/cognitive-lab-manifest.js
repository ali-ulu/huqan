'use strict';

/**
 * Cognitive Lab strict experiment manifest (#3374, slice 3307-S1).
 *
 * The measurement contract for #3307: one frozen description of an experiment
 * that a reader can reproduce from. It carries the source commit, the fixture,
 * split and frame identities, the seed, the per-mechanism flags, the budget and
 * the measurement version. Nothing here runs an experiment or reads a store --
 * it is a pure data contract plus its validator.
 *
 * Strictness is the point. An unknown field is rejected rather than ignored, so
 * a caller cannot smuggle a parameter past the contract; a missing or malformed
 * field is rejected with a typed error; a well-formed manifest that lacks the
 * data an experiment needs (no train or no holdout) is INSUFFICIENT rather than
 * silently valid. A manifest is only VALID when every field is present, typed
 * and adequate.
 *
 * The digest is deterministic: it is sha256 over a canonical JSON rendering
 * with recursively sorted keys, so two manifests that differ only in field
 * order hash the same. Split id lists are treated as sets (sorted and
 * deduplicated) because split identity is about which ids are in the split, not
 * the order a fixture happened to list them in.
 *
 * This is a leaf in the Core ring. It requires only content-hash and
 * is-plain-object, both Core, so it opens no require cycle and adds no runtime
 * surface (#3374: wiring/activation/policy/receipt/release are explicitly out
 * of scope).
 */

const { contentHash } = require('./content-hash');
const { isPlainObject } = require('./is-plain-object');

const MANIFEST_SCHEMA_VERSION = 'huqan-cognitive-lab-manifest-v1';

const MECHANISM_IDS = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']);
const MECHANISM_FLAGS = Object.freeze(['ENABLED', 'DISABLED', 'NOT_MEASURED']);

const MANIFEST_STATUS = Object.freeze({
  VALID: 'VALID',
  INSUFFICIENT: 'INSUFFICIENT',
  REJECT: 'REJECT',
});

const MANIFEST_ERROR_CODES = Object.freeze({
  MISSING_FIELD: 'manifest_missing_field',
  UNKNOWN_FIELD: 'manifest_unknown_field',
  INVALID_FIELD: 'manifest_invalid_field',
  NON_FINITE_NUMBER: 'manifest_non_finite_number',
  EMPTY_SPLIT: 'manifest_empty_split',
  DIGEST_MISMATCH: 'manifest_digest_mismatch',
});

/**
 * A typed manifest failure. `code` is a MANIFEST_ERROR_CODES value and `path`
 * is the dotted location of the offending field, so a caller can react to the
 * failure instead of parsing a message.
 */
class CognitiveLabManifestError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'CognitiveLabManifestError';
    this.code = code;
    this.path = path;
  }
}

const HEX_64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

// Field contract, walked generically so a new field is one entry rather than a
// new branch. `object` nodes list their own required fields; a field is missing
// when it is absent, and unknown when it is present but not listed.
const MANIFEST_SPEC = Object.freeze({
  schemaVersion: { kind: 'literal', value: MANIFEST_SCHEMA_VERSION },
  source: {
    kind: 'object',
    fields: {
      repository: { kind: 'string' },
      commit: { kind: 'commit' },
      dirty: { kind: 'boolean' },
    },
  },
  fixture: { kind: 'object', fields: { digest: { kind: 'digest' } } },
  split: {
    kind: 'object',
    fields: {
      identity: { kind: 'digest' },
      train: { kind: 'idList' },
      holdout: { kind: 'idList' },
      transfer: { kind: 'idList' },
    },
  },
  frame: {
    kind: 'object',
    fields: {
      repository: { kind: 'string' },
      branch: { kind: 'string' },
      environment: { kind: 'string' },
      task: { kind: 'string' },
    },
  },
  seed: { kind: 'nonNegativeInteger' },
  mechanisms: { kind: 'mechanisms' },
  budget: {
    kind: 'object',
    fields: {
      modelCalls: { kind: 'countOrUnknown' },
      toolCalls: { kind: 'countOrUnknown' },
      humanCalls: { kind: 'countOrUnknown' },
      tokens: { kind: 'countOrUnknown' },
      wallTimeMs: { kind: 'countOrUnknown' },
      compute: { kind: 'countOrUnknown' },
    },
  },
  measurementVersion: { kind: 'string' },
  thresholdConfigHash: { kind: 'digest' },
});

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateScalar(kind, value, path, errors) {
  switch (kind) {
    case 'literal':
      if (value !== MANIFEST_SPEC.schemaVersion.value) {
        errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, `expected ${MANIFEST_SPEC.schemaVersion.value}`));
      }
      return;
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected a non-empty string'));
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected a boolean'));
      }
      return;
    case 'commit':
      if (typeof value !== 'string' || !COMMIT.test(value)) {
        errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected a 7-64 char lowercase hex commit'));
      }
      return;
    case 'digest':
      if (typeof value !== 'string' || !HEX_64.test(value)) {
        errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected a 64 char lowercase hex digest'));
      }
      return;
    case 'nonNegativeInteger':
      if (!isNonNegativeInteger(value)) {
        errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected a non-negative integer'));
      }
      return;
    case 'countOrUnknown':
      if (value === null) return;
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(error(MANIFEST_ERROR_CODES.NON_FINITE_NUMBER, path, 'a counter cannot be NaN or Infinity'));
        return;
      }
      if (!isNonNegativeInteger(value)) {
        errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected a non-negative integer or null for unknown'));
      }
      return;
    case 'idList':
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
        errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected a list of non-empty string ids'));
      }
      return;
    case 'mechanisms':
      validateMechanisms(value, path, errors);
      return;
    default:
      errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, `unknown contract kind ${kind}`));
  }
}

function validateMechanisms(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected a mechanisms object'));
    return;
  }
  for (const id of MECHANISM_IDS) {
    const flag = value[id];
    if (flag === undefined) {
      errors.push(error(MANIFEST_ERROR_CODES.MISSING_FIELD, `${path}.${id}`, 'every B1-B8 mechanism flag is required'));
      continue;
    }
    if (!MECHANISM_FLAGS.includes(flag)) {
      errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, `${path}.${id}`, `expected one of ${MECHANISM_FLAGS.join('/')}`));
    }
  }
  for (const key of Object.keys(value)) {
    if (!MECHANISM_IDS.includes(key)) {
      errors.push(error(MANIFEST_ERROR_CODES.UNKNOWN_FIELD, `${path}.${key}`, 'unknown mechanism id'));
    }
  }
}

function validateNode(spec, value, path, errors) {
  if (spec.kind === 'object') {
    if (!isPlainObject(value)) {
      errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, path, 'expected an object'));
      return;
    }
    for (const field of Object.keys(spec.fields)) {
      if (value[field] === undefined) {
        errors.push(error(MANIFEST_ERROR_CODES.MISSING_FIELD, `${path}.${field}`, 'required field is missing'));
        continue;
      }
      validateNode(spec.fields[field], value[field], `${path}.${field}`, errors);
    }
    for (const key of Object.keys(value)) {
      if (spec.fields[key] === undefined) {
        errors.push(error(MANIFEST_ERROR_CODES.UNKNOWN_FIELD, `${path}.${key}`, 'unknown field is not part of the contract'));
      }
    }
    return;
  }
  validateScalar(spec.kind, value, path, errors);
}

function error(code, path, message) {
  return Object.freeze({ code, path, message });
}

function normalizeIdList(list) {
  return [...new Set(list)].sort();
}

function normalizeNode(spec, value) {
  if (spec.kind === 'object') {
    const normalized = {};
    for (const field of Object.keys(spec.fields)) {
      normalized[field] = normalizeNode(spec.fields[field], value[field]);
    }
    return Object.freeze(normalized);
  }
  if (spec.kind === 'idList') return Object.freeze(normalizeIdList(value));
  if (spec.kind === 'mechanisms') {
    const normalized = {};
    for (const id of MECHANISM_IDS) normalized[id] = value[id];
    return Object.freeze(normalized);
  }
  return value;
}

function normalizeManifest(input) {
  return normalizeNode({ kind: 'object', fields: MANIFEST_SPEC }, input);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

/**
 * sha256 over the canonical rendering of an already-normalized manifest. Field
 * order does not change the digest; set-like split ids are normalized by the
 * caller first.
 */
function computeManifestDigest(manifest) {
  return contentHash(stableStringify(manifest));
}

function splitInsufficiency(manifest) {
  if (manifest.split.train.length === 0) return 'split.train is empty';
  if (manifest.split.holdout.length === 0) return 'split.holdout is empty';
  return null;
}

/**
 * Validate an untrusted manifest.
 *
 * @returns {Readonly<{status: string, errors: ReadonlyArray, digest: string|null, manifest: object|null}>}
 *   REJECT when any field is missing, unknown or malformed; INSUFFICIENT when
 *   the shape is sound but the split has no train/holdout data; VALID otherwise.
 *   `digest`/`manifest` are present for VALID and INSUFFICIENT.
 */
function validateManifest(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    errors.push(error(MANIFEST_ERROR_CODES.INVALID_FIELD, '', 'manifest must be an object'));
    return Object.freeze({ status: MANIFEST_STATUS.REJECT, errors: Object.freeze(errors), digest: null, manifest: null });
  }

  for (const field of Object.keys(MANIFEST_SPEC)) {
    if (input[field] === undefined) {
      errors.push(error(MANIFEST_ERROR_CODES.MISSING_FIELD, field, 'required field is missing'));
    }
  }
  for (const key of Object.keys(input)) {
    if (MANIFEST_SPEC[key] === undefined) {
      errors.push(error(MANIFEST_ERROR_CODES.UNKNOWN_FIELD, key, 'unknown field is not part of the contract'));
    }
  }
  for (const field of Object.keys(MANIFEST_SPEC)) {
    if (input[field] !== undefined) validateNode(MANIFEST_SPEC[field], input[field], field, errors);
  }
  if (errors.length > 0) {
    return Object.freeze({ status: MANIFEST_STATUS.REJECT, errors: Object.freeze(errors), digest: null, manifest: null });
  }

  const manifest = Object.freeze(normalizeManifest(input));
  const digest = computeManifestDigest(manifest);
  const insufficient = splitInsufficiency(manifest);
  if (insufficient) {
    return Object.freeze({
      status: MANIFEST_STATUS.INSUFFICIENT,
      errors: Object.freeze([error(MANIFEST_ERROR_CODES.EMPTY_SPLIT, 'split', insufficient)]),
      digest,
      manifest,
    });
  }
  return Object.freeze({ status: MANIFEST_STATUS.VALID, errors: Object.freeze([]), digest, manifest });
}

/**
 * Validate and freeze a manifest, throwing the first typed error when it is not
 * VALID. Use this when a caller needs a manifest rather than a verdict.
 */
function buildManifest(input) {
  const result = validateManifest(input);
  if (result.status !== MANIFEST_STATUS.VALID) {
    const first = result.errors[0];
    throw new CognitiveLabManifestError(first.code, first.path, first.message);
  }
  return Object.freeze({ manifest: result.manifest, digest: result.digest });
}

/**
 * Recompute a manifest's digest and compare it to an expected value. A tampered
 * field changes the digest, so the mismatch is REJECT with a typed error.
 */
function verifyManifestDigest(manifest, expectedDigest) {
  const digest = computeManifestDigest(manifest);
  if (digest !== expectedDigest) {
    return Object.freeze({
      status: MANIFEST_STATUS.REJECT,
      errors: Object.freeze([
        error(MANIFEST_ERROR_CODES.DIGEST_MISMATCH, 'digest', 'manifest digest does not match the expected value'),
      ]),
      digest,
      manifest: null,
    });
  }
  return Object.freeze({ status: MANIFEST_STATUS.VALID, errors: Object.freeze([]), digest, manifest: null });
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  MECHANISM_IDS,
  MECHANISM_FLAGS,
  MANIFEST_STATUS,
  MANIFEST_ERROR_CODES,
  CognitiveLabManifestError,
  validateManifest,
  buildManifest,
  computeManifestDigest,
  verifyManifestDigest,
};
