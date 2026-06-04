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

function validateCausalEdge(input) {
  const errors = [];
  const warnings = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      value: null,
      errors: [{ code: CAUSAL_EDGE_ERROR_CODES.MISSING_FIELD, message: 'edge input must be an object' }],
      warnings: [],
    };
  }

  const missing = collectMissingFields(input);
  if (missing.length > 0) {
    for (const field of missing) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.MISSING_FIELD,
        message: `required field '${field}' is missing`,
        field,
      });
    }
  }

  if (isNonEmptyString(input.from) && isNonEmptyString(input.to) && input.from === input.to) {
    errors.push({
      code: CAUSAL_EDGE_ERROR_CODES.SELF_EDGE,
      message: 'edge from and to must differ (self-edge forbidden)',
      field: 'to',
    });
  }

  if (Object.prototype.hasOwnProperty.call(input, 'relation')) {
    if (!CAUSAL_EDGE_RELATIONS.includes(input.relation)) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.INVALID_RELATION,
        message: `relation '${String(input.relation)}' is not in CAUSAL_EDGE_RELATIONS`,
        field: 'relation',
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'strength')) {
    if (typeof input.strength !== 'number' || !Number.isFinite(input.strength)) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.INVALID_STRENGTH,
        message: 'strength must be a finite number',
        field: 'strength',
      });
    } else if (input.strength < 0 || input.strength > 1) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.INVALID_STRENGTH,
        message: 'strength must be in [0, 1]',
        field: 'strength',
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'workspaceId')) {
    if (!isNonEmptyString(input.workspaceId)) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.INVALID_WORKSPACE_ID,
        message: 'workspaceId must be a non-empty string',
        field: 'workspaceId',
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'provenanceId')) {
    if (!isStableId(input.provenanceId)) {
      if (!isNonEmptyString(input.provenanceId)) {
        errors.push({
          code: CAUSAL_EDGE_ERROR_CODES.EMPTY_PROVENANCE_ID,
          message: 'provenanceId must be a non-empty string',
          field: 'provenanceId',
        });
      } else {
        errors.push({
          code: CAUSAL_EDGE_ERROR_CODES.INVALID_PROVENANCE_ID,
          message: 'provenanceId must be stable (no leading/trailing whitespace)',
          field: 'provenanceId',
        });
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'trustPolicyVersion')) {
    if (!isNonEmptyString(input.trustPolicyVersion)) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.MISSING_TRUST_POLICY_VERSION,
        message: 'trustPolicyVersion must be a non-empty string',
        field: 'trustPolicyVersion',
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'createdAt')) {
    if (!isIso8601(input.createdAt)) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.INVALID_TIMESTAMP,
        message: 'createdAt must be an ISO-8601 timestamp',
        field: 'createdAt',
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'edgeSchemaVersion')) {
    if (input.edgeSchemaVersion !== CAUSAL_EDGE_SCHEMA_VERSION) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.INVALID_EDGE_SCHEMA_VERSION,
        message: `edgeSchemaVersion must be '${CAUSAL_EDGE_SCHEMA_VERSION}'`,
        field: 'edgeSchemaVersion',
      });
    }
  }

  for (const field of CAUSAL_FUTURE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (input[field] !== null) {
      errors.push({
        code: CAUSAL_EDGE_ERROR_CODES.FUTURE_FIELD_NOT_NULL,
        message: `future field '${field}' must be null in V1 (got ${typeof input[field]})`,
        field,
      });
    }
  }

  if (
    typeof input.strength === 'number' &&
    Number.isFinite(input.strength) &&
    input.strength >= 0 &&
    input.strength <= 1 &&
    Object.prototype.hasOwnProperty.call(input, 'strengthLabel')
  ) {
    const expectedLabel = strengthToLabel(input.strength);
    if (input.strengthLabel !== expectedLabel) {
      warnings.push({
        code: CAUSAL_EDGE_ERROR_CODES.STRENGTH_LABEL_MISMATCH,
        message: `strengthLabel '${input.strengthLabel}' does not match band '${expectedLabel}' for strength ${input.strength}`,
        field: 'strengthLabel',
      });
    }
  }

  return {
    ok: errors.length === 0,
    value: null,
    errors,
    warnings,
  };
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
    out.strengthLabel = input.strengthLabel;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'confidence')) {
    out.confidence = input.confidence;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'metadata')) {
    out.metadata = input.metadata;
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
