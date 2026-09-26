'use strict';

const { CAUSAL_RELATIONS } = require('../../graph');
const {
  CAUSAL_EDGE_ERROR_CODES,
  CausalEdgeValidationError,
} = require('./causal-edge-errors');

const CAUSAL_EDGE_RELATIONS = Object.freeze([...CAUSAL_RELATIONS]);

const CAUSAL_STRENGTH_BANDS = Object.freeze([
  Object.freeze({ id: 'weak', min: 0.00, max: 0.25 }),
  Object.freeze({ id: 'medium', min: 0.25, max: 0.50 }),
  Object.freeze({ id: 'strong', min: 0.50, max: 0.75 }),
  Object.freeze({ id: 'very_strong', min: 0.75, max: 1.01 }),
]);

const CAUSAL_EDGE_SCHEMA_VERSION = '1.0.0';

const CAUSAL_FUTURE_FIELDS = Object.freeze([
  'temporal',
  'probability',
  'formalProof',
  'worldModel',
  'causalProjection',
  'counterfactualTrace',
  'simulationReceipt',
]);

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const REQUIRED_FIELDS = Object.freeze([
  'id',
  'from',
  'to',
  'relation',
  'strength',
  'workspaceId',
  'provenanceId',
  'trustPolicyVersion',
  'createdAt',
  'edgeSchemaVersion',
]);

function bandForStrength(strength) {
  for (const band of CAUSAL_STRENGTH_BANDS) {
    if (strength >= band.min && strength < band.max) return band;
  }
  return CAUSAL_STRENGTH_BANDS[CAUSAL_STRENGTH_BANDS.length - 1];
}

function strengthToLabel(strength) {
  if (typeof strength !== 'number' || !Number.isFinite(strength)) return null;
  if (strength < 0 || strength > 1) return null;
  return bandForStrength(strength).id;
}

function labelToBand(label) {
  if (typeof label !== 'string') return null;
  for (const band of CAUSAL_STRENGTH_BANDS) {
    if (band.id === label) return band;
  }
  return null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStableId(value) {
  if (!isNonEmptyString(value)) return false;
  return value.trim() === value;
}

function isIso8601(value) {
  if (typeof value !== 'string' || !value) return false;
  if (!ISO_8601_REGEX.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function collectMissingFields(input) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      missing.push(field);
    }
  }
  return missing;
}

const has = (input, field) => Object.prototype.hasOwnProperty.call(input, field);

function fieldError(code, message, field) {
  return { code, message, field };
}

function unitIntervalError(value, field, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fieldError(code, `${field} must be a finite number`, field);
  }
  if (value < 0 || value > 1) return fieldError(code, `${field} must be in [0, 1]`, field);
  return null;
}

/**
 * The per-field checks of validateCausalEdge, in the order their errors are
 * reported (#2401). A field rule runs only when the field is present --
 * absence is reported once, by collectMissingFields -- and returns an error or
 * null. A new field is a new row here, not another if-block.
 */
const FIELD_RULES = Object.freeze([
  ['id', (value) => (isNonEmptyString(value) ? null
    : fieldError(CAUSAL_EDGE_ERROR_CODES.INVALID_ID, 'id must be a non-empty string', 'id'))],
  ['from', (value) => (isNonEmptyString(value) ? null
    : fieldError(CAUSAL_EDGE_ERROR_CODES.INVALID_ENDPOINT, 'from must be a non-empty string', 'from'))],
  ['to', (value) => (isNonEmptyString(value) ? null
    : fieldError(CAUSAL_EDGE_ERROR_CODES.INVALID_ENDPOINT, 'to must be a non-empty string', 'to'))],
  [null, (input) => (isNonEmptyString(input.from) && isNonEmptyString(input.to) && input.from === input.to
    ? fieldError(CAUSAL_EDGE_ERROR_CODES.SELF_EDGE, 'edge from and to must differ (self-edge forbidden)', 'to')
    : null)],
  ['relation', (value) => (CAUSAL_EDGE_RELATIONS.includes(value) ? null
    : fieldError(CAUSAL_EDGE_ERROR_CODES.INVALID_RELATION, `relation '${String(value)}' is not in CAUSAL_EDGE_RELATIONS`, 'relation'))],
  ['strength', (value) => unitIntervalError(value, 'strength', CAUSAL_EDGE_ERROR_CODES.INVALID_STRENGTH)],
  ['confidence', (value) => unitIntervalError(value, 'confidence', CAUSAL_EDGE_ERROR_CODES.INVALID_CONFIDENCE)],
  ['workspaceId', (value) => (isNonEmptyString(value) ? null
    : fieldError(CAUSAL_EDGE_ERROR_CODES.INVALID_WORKSPACE_ID, 'workspaceId must be a non-empty string', 'workspaceId'))],
  ['provenanceId', (value) => {
    if (isStableId(value)) return null;
    return isNonEmptyString(value)
      ? fieldError(CAUSAL_EDGE_ERROR_CODES.INVALID_PROVENANCE_ID, 'provenanceId must be stable (no leading/trailing whitespace)', 'provenanceId')
      : fieldError(CAUSAL_EDGE_ERROR_CODES.EMPTY_PROVENANCE_ID, 'provenanceId must be a non-empty string', 'provenanceId');
  }],
  ['trustPolicyVersion', (value) => (isNonEmptyString(value) ? null
    : fieldError(CAUSAL_EDGE_ERROR_CODES.MISSING_TRUST_POLICY_VERSION, 'trustPolicyVersion must be a non-empty string', 'trustPolicyVersion'))],
  ['createdAt', (value) => (isIso8601(value) ? null
    : fieldError(CAUSAL_EDGE_ERROR_CODES.INVALID_TIMESTAMP, 'createdAt must be an ISO-8601 timestamp', 'createdAt'))],
  ['edgeSchemaVersion', (value) => (value === CAUSAL_EDGE_SCHEMA_VERSION ? null
    : fieldError(CAUSAL_EDGE_ERROR_CODES.INVALID_EDGE_SCHEMA_VERSION, `edgeSchemaVersion must be '${CAUSAL_EDGE_SCHEMA_VERSION}'`, 'edgeSchemaVersion'))],
]);

function futureFieldErrors(input) {
  return CAUSAL_FUTURE_FIELDS
    .filter((field) => has(input, field) && input[field] !== null)
    .map((field) => fieldError(
      CAUSAL_EDGE_ERROR_CODES.FUTURE_FIELD_NOT_NULL,
      `future field '${field}' must be null in V1 (got ${typeof input[field]})`,
      field,
    ));
}

/** A declared strengthLabel must name the band of a valid strength. */
function strengthLabelError(input) {
  if (unitIntervalError(input.strength, 'strength', null) !== null) return null;
  if (!has(input, 'strengthLabel') || input.strengthLabel === null) return null;
  const expectedLabel = strengthToLabel(input.strength);
  if (input.strengthLabel === expectedLabel) return null;
  return fieldError(
    CAUSAL_EDGE_ERROR_CODES.STRENGTH_LABEL_MISMATCH,
    `strengthLabel '${input.strengthLabel}' does not match band '${expectedLabel}' for strength ${input.strength}`,
    'strengthLabel',
  );
}

function validateCausalEdge(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      value: null,
      errors: [{ code: CAUSAL_EDGE_ERROR_CODES.MISSING_FIELD, message: 'edge input must be an object' }],
      warnings: [],
    };
  }

  const errors = collectMissingFields(input).map((field) => fieldError(
    CAUSAL_EDGE_ERROR_CODES.MISSING_FIELD,
    `required field '${field}' is missing`,
    field,
  ));
  for (const [field, check] of FIELD_RULES) {
    if (field === null) {
      const error = check(input);
      if (error) errors.push(error);
    } else if (has(input, field)) {
      const error = check(input[field]);
      if (error) errors.push(error);
    }
  }
  errors.push(...futureFieldErrors(input));
  const labelError = strengthLabelError(input);
  if (labelError) errors.push(labelError);

  return { ok: errors.length === 0, value: null, errors, warnings: [] };
}

function normalizeCausalEdge(input) {
  const result = validateCausalEdge(input);
  if (!result.ok) {
    const first = result.errors[0];
    throw new CausalEdgeValidationError(
      first.code,
      first.message,
      first.field ? { field: first.field } : null,
    );
  }

  const out = {
    id: input.id,
    from: input.from,
    to: input.to,
    relation: input.relation,
    strength: input.strength,
    workspaceId: input.workspaceId,
    provenanceId: input.provenanceId,
    trustPolicyVersion: input.trustPolicyVersion,
    createdAt: input.createdAt,
    edgeSchemaVersion: CAUSAL_EDGE_SCHEMA_VERSION,
  };

  if (Object.prototype.hasOwnProperty.call(input, 'strengthLabel')) {
    out.strengthLabel = input.strengthLabel === null
      ? null
      : strengthToLabel(input.strength);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'confidence')) {
    out.confidence = input.confidence;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'metadata')) {
    out.metadata = input.metadata && typeof input.metadata === 'object'
      ? JSON.parse(JSON.stringify(input.metadata))
      : input.metadata;
  }

  for (const field of CAUSAL_FUTURE_FIELDS) {
    out[field] = null;
  }

  return Object.freeze(out);
}

function createCausalEdge(input) {
  return normalizeCausalEdge(input);
}

module.exports = {
  CAUSAL_EDGE_RELATIONS,
  CAUSAL_STRENGTH_BANDS,
  CAUSAL_EDGE_SCHEMA_VERSION,
  CAUSAL_FUTURE_FIELDS,
  REQUIRED_FIELDS,
  ISO_8601_REGEX,
  bandForStrength,
  strengthToLabel,
  labelToBand,
  isNonEmptyString,
  isStableId,
  isIso8601,
  collectMissingFields,
  validateCausalEdge,
  normalizeCausalEdge,
  createCausalEdge,
};
