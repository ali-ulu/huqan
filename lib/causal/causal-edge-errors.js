'use strict';

const CAUSAL_EDGE_ERROR_CODES = Object.freeze({
  MISSING_FIELD: 'MISSING_FIELD',
  INVALID_RELATION: 'INVALID_RELATION',
  INVALID_STRENGTH: 'INVALID_STRENGTH',
  INVALID_WORKSPACE_ID: 'INVALID_WORKSPACE_ID',
  EMPTY_PROVENANCE_ID: 'EMPTY_PROVENANCE_ID',
  INVALID_PROVENANCE_ID: 'INVALID_PROVENANCE_ID',
  FUTURE_FIELD_NOT_NULL: 'FUTURE_FIELD_NOT_NULL',
  MISSING_TRUST_POLICY_VERSION: 'MISSING_TRUST_POLICY_VERSION',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  INVALID_EDGE_SCHEMA_VERSION: 'INVALID_EDGE_SCHEMA_VERSION',
  STRENGTH_LABEL_MISMATCH: 'STRENGTH_LABEL_MISMATCH',
  SELF_EDGE: 'SELF_EDGE',
});

class CausalEdgeValidationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CausalEdgeValidationError';
    this.code = code;
    if (details !== null && typeof details === 'object') {
      this.details = Object.freeze({ ...details });
    }
  }
}

module.exports = {
  CAUSAL_EDGE_ERROR_CODES,
  CausalEdgeValidationError,
};
