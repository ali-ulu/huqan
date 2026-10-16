'use strict';

/**
 * Model-agnostic CognitiveModel port (#3474, I6).
 *
 * I6 asks for a local neural cognition candidate behind a model-agnostic port:
 * an RWKV, Mamba, small Transformer or SSM implementation may all answer
 * through it, and B7 measures quality, budget and locality. This module is the
 * port only -- a pure data contract plus its validator. It runs no model, reads
 * no store and adds no runtime surface.
 *
 * The authority boundary is the point. A candidate is a PROPOSAL: a bounded
 * answer with a finite confidence and a declared budget and locality. It never
 * carries authority -- `authority` is the literal 'CANDIDATE_ONLY' and
 * `canonical` is false -- so a caller cannot mistake a model output for a
 * verified fact, an admitted action or a canonical rule. Strictness is the
 * rest: an unknown field is rejected rather than ignored, a non-finite number
 * is rejected rather than scored, and a candidate that declares an external
 * locality is rejected because the point of I6 is a *local* model.
 */

const { isPlainObject } = require('./is-plain-object');

const COGNITIVE_MODEL_SCHEMA_VERSION = 'huqan-cognitive-model-v1';
const MODEL_AUTHORITY = 'CANDIDATE_ONLY';
const MODEL_KINDS = Object.freeze(['RWKV', 'MAMBA', 'SSM', 'TRANSFORMER', 'DETERMINISTIC']);
const MODEL_LOCALITY = Object.freeze(['LOCAL', 'EXTERNAL']);

const PORT_STATUS = Object.freeze({ VALID: 'VALID', REJECT: 'REJECT' });

const PORT_ERROR_CODES = Object.freeze({
  INVALID_FIELD: 'cognitive_model_invalid_field',
  MISSING_FIELD: 'cognitive_model_missing_field',
  UNKNOWN_FIELD: 'cognitive_model_unknown_field',
  NON_FINITE_NUMBER: 'cognitive_model_non_finite_number',
  EXTERNAL_CALL: 'cognitive_model_external_call',
});

const HEX_64 = /^[0-9a-f]{64}$/;
const TEXT = /^[^\0]{1,128}$/;
const MAX_ABS_SCORE = 1e6;

function error(code, path, message) {
  return Object.freeze({ code, path, message });
}

function isBoundedText(value) {
  return typeof value === 'string' && TEXT.test(value) && value.trim() !== '';
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

const PROPOSAL_SPEC = Object.freeze({
  schemaVersion: { kind: 'literal', value: COGNITIVE_MODEL_SCHEMA_VERSION },
  modelId: { kind: 'text' },
  kind: { kind: 'oneOf', values: MODEL_KINDS },
  locality: { kind: 'oneOf', values: MODEL_LOCALITY },
  modelDigest: { kind: 'digest' },
  answer: {
    kind: 'object',
    fields: {
      label: { kind: 'text' },
      score: { kind: 'boundedNumber' },
    },
  },
  confidence: { kind: 'unitInterval' },
  budget: {
    kind: 'object',
    fields: {
      modelCalls: { kind: 'nonNegativeInteger' },
      tokens: { kind: 'nonNegativeInteger' },
      operations: { kind: 'nonNegativeInteger' },
    },
  },
});

// The two fields buildProposal adds. They are validated on re-validation so a
// caller cannot submit `authority: true`, but they are not required input.
const OUTPUT_SPEC = Object.freeze({
  authority: { kind: 'literal', value: MODEL_AUTHORITY },
  canonical: { kind: 'literal', value: false },
});

function validateScalar(spec, value, path, errors) {
  switch (spec.kind) {
    case 'literal':
      if (value !== spec.value) errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, `expected ${spec.value}`));
      return;
    case 'text':
      if (!isBoundedText(value)) errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, 'expected bounded non-empty text'));
      return;
    case 'digest':
      if (typeof value !== 'string' || !HEX_64.test(value)) errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, 'expected a 64 char lowercase hex digest'));
      return;
    case 'oneOf':
      if (!spec.values.includes(value)) errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, `expected one of ${spec.values.join('/')}`));
      return;
    case 'unitInterval':
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(error(PORT_ERROR_CODES.NON_FINITE_NUMBER, path, 'confidence must be finite'));
      } else if (!isFiniteNumber(value) || value < 0 || value > 1) {
        errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, 'confidence must be a finite number in [0, 1]'));
      }
      return;
    case 'boundedNumber':
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(error(PORT_ERROR_CODES.NON_FINITE_NUMBER, path, 'score must be finite'));
      } else if (!isFiniteNumber(value) || Math.abs(value) > MAX_ABS_SCORE) {
        errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, 'score must be a finite bounded number'));
      }
      return;
    case 'nonNegativeInteger':
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(error(PORT_ERROR_CODES.NON_FINITE_NUMBER, path, 'counter must be finite'));
      } else if (!isNonNegativeInteger(value)) {
        errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, 'expected a non-negative integer'));
      }
      return;
    default:
      errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, `unknown contract kind ${spec.kind}`));
  }
}

function validateNode(spec, value, path, errors) {
  if (spec.kind === 'object') {
    if (!isPlainObject(value)) {
      errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, path, 'expected an object'));
      return;
    }
    for (const field of Object.keys(spec.fields)) {
      if (value[field] === undefined) {
        errors.push(error(PORT_ERROR_CODES.MISSING_FIELD, `${path}.${field}`, 'required field is missing'));
        continue;
      }
      validateNode(spec.fields[field], value[field], `${path}.${field}`, errors);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(spec.fields, key)) {
        errors.push(error(PORT_ERROR_CODES.UNKNOWN_FIELD, `${path}.${key}`, 'unknown field is not part of the contract'));
      }
    }
    return;
  }
  validateScalar(spec, value, path, errors);
}

function normalizeNode(spec, value) {
  if (spec.kind === 'object') {
    const normalized = {};
    for (const field of Object.keys(spec.fields)) normalized[field] = normalizeNode(spec.fields[field], value[field]);
    return Object.freeze(normalized);
  }
  return value;
}

/**
 * Validate an untrusted candidate proposal.
 *
 * @returns {Readonly<{status: string, errors: ReadonlyArray, proposal: object|null}>}
 *   REJECT when a field is missing, unknown or malformed, when a number is not
 *   finite, or when the proposal declares an external locality; VALID otherwise.
 */
function validateProposal(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    errors.push(error(PORT_ERROR_CODES.INVALID_FIELD, '', 'proposal must be an object'));
    return Object.freeze({ status: PORT_STATUS.REJECT, errors: Object.freeze(errors), proposal: null });
  }
  for (const field of Object.keys(PROPOSAL_SPEC)) {
    if (input[field] === undefined) errors.push(error(PORT_ERROR_CODES.MISSING_FIELD, field, 'required field is missing'));
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(PROPOSAL_SPEC, key) && !Object.hasOwn(OUTPUT_SPEC, key)) {
      errors.push(error(PORT_ERROR_CODES.UNKNOWN_FIELD, key, 'unknown field is not part of the contract'));
    }
  }
  for (const field of Object.keys(PROPOSAL_SPEC)) {
    if (input[field] !== undefined) validateNode(PROPOSAL_SPEC[field], input[field], field, errors);
  }
  for (const field of Object.keys(OUTPUT_SPEC)) {
    if (input[field] !== undefined) validateNode(OUTPUT_SPEC[field], input[field], field, errors);
  }
  // A local model port must never admit an external dependency, even when every
  // other field is well-formed: that is a locality contract, not a data error.
  if (input.locality === 'EXTERNAL') {
    errors.push(error(PORT_ERROR_CODES.EXTERNAL_CALL, 'locality', 'a local cognitive model port rejects an external locality'));
  }
  if (errors.length > 0) {
    return Object.freeze({ status: PORT_STATUS.REJECT, errors: Object.freeze(errors), proposal: null });
  }
  const normalized = normalizeNode(PROPOSAL_SPEC, input);
  const proposal = Object.freeze({ ...normalized, authority: MODEL_AUTHORITY, canonical: false });
  return Object.freeze({ status: PORT_STATUS.VALID, errors: Object.freeze([]), proposal });
}

/**
 * Validate and freeze a proposal, throwing the first typed error when it is not
 * VALID. A model implementation uses this to build the object it returns, so a
 * malformed proposal can never leave the model.
 */
function buildProposal(input) {
  const result = validateProposal(input);
  if (result.status !== PORT_STATUS.VALID) {
    const first = result.errors[0];
    const failure = new TypeError(`${first.code} at ${first.path}: ${first.message}`);
    failure.code = first.code;
    failure.path = first.path;
    throw failure;
  }
  return result.proposal;
}

module.exports = {
  COGNITIVE_MODEL_SCHEMA_VERSION,
  MODEL_AUTHORITY,
  MODEL_KINDS,
  MODEL_LOCALITY,
  PORT_STATUS,
  PORT_ERROR_CODES,
  validateProposal,
  buildProposal,
};
