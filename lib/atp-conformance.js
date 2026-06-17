const fs = require('fs');

const ATP_OBJECT_TYPES = Object.freeze({
  provenanceRecord: 'provenance-record',
  auditEvent: 'audit-event',
  candidateClaim: 'candidate-claim',
  conflictResult: 'conflict-result',
  verificationResult: 'verification-result',
  trustReceipt: 'trust-receipt',
  causalChain: 'causal-chain',
  simulationResult: 'simulation-result',
  error: 'error',
});

const SOURCE_TYPES = new Set(['document', 'api', 'user', 'agent', 'system', 'github', 'import', 'llm']);
const AUDIT_EVENT_TYPES = new Set(['LEARN', 'REJECT', 'UPDATE', 'DELETE', 'QUERY', 'CONFLICT_DETECTED', 'CLAIM_FLAGGED', 'CLAIM_ACCEPTED', 'CLAIM_REJECTED', 'REAFFIRMED', 'IMPORTED', 'EXPORTED']);
const CANDIDATE_STATUSES = new Set(['pending', 'accepted', 'rejected']);
const RECOMMENDATIONS = new Set(['accept', 'flag', 'reject']);
const TRUST_STATUSES = new Set(['canonical', 'pending', 'flagged', 'rejected', 'unknown']);
const VERIFICATION_STATUSES = new Set(['verified', 'unsupported', 'contradicted', 'pending', 'unknown']);
const VERIFICATION_MODES = new Set(['graph-backed', 'llm-assisted', 'unsupported', 'contradicted', 'causal', 'insufficient-data']);
const CONFLICT_TYPES = new Set(['agent-vs-agent', 'agent-vs-graph', 'agent-vs-causal', 'provenance-mismatch', 'workspace-scope-mismatch', null]);
const RISK_LEVELS = new Set(['critical', 'high', 'medium', 'low', 'unknown']);
const ERROR_CODES = new Set(['PROVENANCE_REQUIRED', 'WORKSPACE_SCOPE_MISMATCH', 'INVALID_ATP_OBJECT', 'CONFLICT_DETECTED', 'NOT_FOUND', 'VALIDATION_ERROR']);
const CAUSAL_RELATIONS = new Set(['CAUSES', 'PREVENTS', 'ENABLES', 'DEPENDS_ON', 'LEADS_TO']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJsonSafe(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeATPValidationError(error, fallbackField = '') {
  if (!error) {
    return { code: 'VALIDATION_ERROR', field: fallbackField, message: 'Unknown validation error' };
  }
  if (typeof error === 'string') {
    return { code: 'VALIDATION_ERROR', field: fallbackField, message: error };
  }
  return {
    code: typeof error.code === 'string' && error.code ? error.code : 'VALIDATION_ERROR',
    field: typeof error.field === 'string' ? error.field : fallbackField,
    message: typeof error.message === 'string' && error.message ? error.message : 'Validation error',
  };
}

function createResult(type, warnings = [], errors = []) {
  return { ok: errors.length === 0, type, warnings, errors };
}

function pushError(errors, code, field, message) {
  errors.push({ code, field, message });
}

function pushRequiredString(errors, obj, field, code = 'VALIDATION_ERROR') {
  if (!isPlainObject(obj) || typeof obj[field] !== 'string' || !obj[field].trim()) {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

function pushRequiredObject(errors, obj, field, code = 'VALIDATION_ERROR') {
  if (!isPlainObject(obj) || obj[field] === undefined || obj[field] === null || typeof obj[field] !== 'object' || Array.isArray(obj[field])) {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

function pushRequiredArray(errors, obj, field, code = 'VALIDATION_ERROR') {
  if (!isPlainObject(obj) || !Array.isArray(obj[field])) {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

function pushRequiredBoolean(errors, obj, field, code = 'VALIDATION_ERROR') {
  if (!isPlainObject(obj) || typeof obj[field] !== 'boolean') {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

function validateTimestamp(errors, value, field) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} must be a parseable timestamp`);
    return false;
  }
  return true;
}

function validateConfidence(errors, value, field) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} must be a number between 0 and 1`);
    return false;
  }
  return true;
}

function validateProvenanceRecord(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'provenance record must be an object');
    return createResult(ATP_OBJECT_TYPES.provenanceRecord, warnings, errors);
  }

  pushRequiredString(errors, object, 'provenanceId');
  pushRequiredString(errors, object, 'sourceRef');
  pushRequiredString(errors, object, 'sourceTitle');
  pushRequiredString(errors, object, 'sourceType');
  pushRequiredString(errors, object, 'actor');
  pushRequiredString(errors, object, 'timestamp');
  pushRequiredString(errors, object, 'workspaceId');
  pushRequiredString(errors, object, 'trustPolicyVersion');
  validateTimestamp(errors, object.timestamp, 'timestamp');
  validateConfidence(errors, object.confidence, 'confidence');
  if (!SOURCE_TYPES.has(object.sourceType)) {
    pushError(errors, 'VALIDATION_ERROR', 'sourceType', 'sourceType is not a supported ATP source type');
  }

  return createResult(ATP_OBJECT_TYPES.provenanceRecord, warnings, errors);
}

function validateAuditEvent(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'audit event must be an object');
    return createResult(ATP_OBJECT_TYPES.auditEvent, warnings, errors);
  }

  pushRequiredString(errors, object, 'auditId');
  pushRequiredString(errors, object, 'eventType');
  pushRequiredString(errors, object, 'targetType');
  pushRequiredString(errors, object, 'targetId');
  pushRequiredString(errors, object, 'workspaceId');
  pushRequiredString(errors, object, 'actor');
  pushRequiredString(errors, object, 'timestamp');
  pushRequiredString(errors, object, 'sourceRef');
  pushRequiredString(errors, object, 'provenanceId');
  pushRequiredString(errors, object, 'trustPolicyVersion');
  validateTimestamp(errors, object.timestamp, 'timestamp');
  if (!AUDIT_EVENT_TYPES.has(object.eventType)) {
    pushError(errors, 'VALIDATION_ERROR', 'eventType', 'eventType is not a supported ATP audit event type');
  }
  if (!isJsonSafe(object.details)) {
    pushError(errors, 'VALIDATION_ERROR', 'details', 'details must be JSON-safe');
  }

  return createResult(ATP_OBJECT_TYPES.auditEvent, warnings, errors);
}

function validateCandidateClaim(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'candidate claim must be an object');
    return createResult(ATP_OBJECT_TYPES.candidateClaim, warnings, errors);
  }

  pushRequiredString(errors, object, 'candidateId');
  pushRequiredString(errors, object, 'claim');
  pushRequiredObject(errors, object, 'proposedEdge');
  pushRequiredObject(errors, object, 'provenance');
  pushRequiredObject(errors, object, 'conflict');
  pushRequiredString(errors, object, 'recommendation');
  pushRequiredString(errors, object, 'status');
  pushRequiredString(errors, object, 'workspaceId');
  pushRequiredString(errors, object, 'createdAt');
  validateTimestamp(errors, object.createdAt, 'createdAt');
  if (object.reviewedAt !== undefined && object.reviewedAt !== null && object.reviewedAt !== '') {
    validateTimestamp(errors, object.reviewedAt, 'reviewedAt');
  }
  if (!CANDIDATE_STATUSES.has(object.status)) {
    pushError(errors, 'VALIDATION_ERROR', 'status', 'status is not a supported ATP candidate status');
  }
  if (!RECOMMENDATIONS.has(object.recommendation)) {
    pushError(errors, 'VALIDATION_ERROR', 'recommendation', 'recommendation is not a supported ATP recommendation');
  }
  if (object.canonical === true && object.status !== 'accepted') {
    pushError(errors, 'VALIDATION_ERROR', 'canonical', 'pending, flagged, and rejected candidate claims must not be canonical');
  }

  return createResult(ATP_OBJECT_TYPES.candidateClaim, warnings, errors);
}

function validateConflictResult(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'conflict result must be an object');
    return createResult(ATP_OBJECT_TYPES.conflictResult, warnings, errors);
  }

  if (typeof object.conflict !== 'boolean') {
    pushError(errors, 'VALIDATION_ERROR', 'conflict', 'conflict is required');
  }
  if (!CONFLICT_TYPES.has(object.type)) {
    pushError(errors, 'VALIDATION_ERROR', 'type', 'type is not a supported ATP conflict type');
  }
  if (!RECOMMENDATIONS.has(object.recommendation)) {
    pushError(errors, 'VALIDATION_ERROR', 'recommendation', 'recommendation is not a supported ATP recommendation');
  }
  pushRequiredString(errors, object, 'reason');
  if (typeof object.confidenceDelta !== 'number' || Number.isNaN(object.confidenceDelta)) {
    pushError(errors, 'VALIDATION_ERROR', 'confidenceDelta', 'confidenceDelta must be a number');
  }
  pushRequiredArray(errors, object, 'existingEvidence');
  pushRequiredArray(errors, object, 'proposedEvidence');
  pushRequiredString(errors, object, 'workspaceId');
  if (object.provenanceId !== undefined && object.provenanceId !== null && typeof object.provenanceId !== 'string') {
    pushError(errors, 'VALIDATION_ERROR', 'provenanceId', 'provenanceId must be a string when present');
  }
  if (object.sourceRef !== undefined && object.sourceRef !== null && typeof object.sourceRef !== 'string') {
    pushError(errors, 'VALIDATION_ERROR', 'sourceRef', 'sourceRef must be a string when present');
  }

  return createResult(ATP_OBJECT_TYPES.conflictResult, warnings, errors);
}

function validateVerificationResult(object, opts = {}) {
  const warnings = [];
  const errors = [];
  const strictPackageMode = opts.strict === true || opts.packageContext === true;
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'verification result must be an object');
    return createResult(ATP_OBJECT_TYPES.verificationResult, warnings, errors);
  }

  if (typeof object.ok !== 'boolean') {
    pushError(errors, 'VALIDATION_ERROR', 'ok', 'ok is required');
  }
  pushRequiredString(errors, object, 'claim');
  pushRequiredString(errors, object, 'status');
  pushRequiredString(errors, object, 'mode');
  validateConfidence(errors, object.confidence, 'confidence');
  pushRequiredArray(errors, object, 'evidence');
  pushRequiredObject(errors, object, 'provenance');
  if (!(object.conflict === null || isPlainObject(object.conflict))) {
    pushError(errors, 'VALIDATION_ERROR', 'conflict', 'conflict must be an object or null');
  }
  pushRequiredObject(errors, object, 'receipt');
  if (!VERIFICATION_STATUSES.has(object.status)) {
    pushError(errors, 'VALIDATION_ERROR', 'status', 'status is not a supported ATP verification status');
  }
  if (!VERIFICATION_MODES.has(object.mode)) {
    pushError(errors, 'VALIDATION_ERROR', 'mode', 'mode is not a supported ATP verification mode');
  }
  if ((object.status === 'unsupported' || object.status === 'contradicted') && object.ok === true) {
    if (strictPackageMode) {
      pushError(errors, 'VALIDATION_ERROR', 'status', 'unsupported or contradicted verification results cannot be embedded as ok=true');
    } else {
      warnings.push('not_verified');
    }
  }
  if (object.status === 'verified' && (object.mode === 'unsupported' || object.mode === 'contradicted')) {
    pushError(errors, 'VALIDATION_ERROR', 'status', 'unsupported or contradicted results cannot be verified');
  }
  if (object.status === 'verified' && (object.mode === 'graph-backed' || object.mode === 'causal') && object.evidence.length === 0) {
    pushError(errors, 'VALIDATION_ERROR', 'evidence', 'verified graph-backed or causal results require evidence');
  }

  return createResult(ATP_OBJECT_TYPES.verificationResult, warnings, errors);
}

function validateTrustReceipt(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'trust receipt must be an object');
    return createResult(ATP_OBJECT_TYPES.trustReceipt, warnings, errors);
  }

  pushRequiredString(errors, object, 'receiptId');
  pushRequiredString(errors, object, 'targetType');
  pushRequiredString(errors, object, 'targetId');
  pushRequiredString(errors, object, 'claim');
  pushRequiredString(errors, object, 'status');
  pushRequiredString(errors, object, 'workspaceId');
  pushRequiredObject(errors, object, 'provenance');
  pushRequiredString(errors, object, 'trustPolicyVersion');
  validateConfidence(errors, object.confidence, 'confidence');
  pushRequiredArray(errors, object, 'auditTrail');
  if (!(object.conflict === null || isPlainObject(object.conflict))) {
    pushError(errors, 'VALIDATION_ERROR', 'conflict', 'conflict must be an object or null');
  }
  if (!(object.candidateClaim === null || isPlainObject(object.candidateClaim))) {
    pushError(errors, 'VALIDATION_ERROR', 'candidateClaim', 'candidateClaim must be an object or null');
  }
  pushRequiredBoolean(errors, object, 'canonical');
  pushRequiredString(errors, object, 'generatedAt');
  validateTimestamp(errors, object.generatedAt, 'generatedAt');
  if (!TRUST_STATUSES.has(object.status)) {
    pushError(errors, 'VALIDATION_ERROR', 'status', 'status is not a supported ATP trust receipt status');
  }
  if (object.status === 'canonical' && object.canonical !== true) {
    pushError(errors, 'VALIDATION_ERROR', 'canonical', 'canonical trust receipts must have canonical=true');
  }
  if (object.status !== 'canonical' && object.canonical === true) {
    pushError(errors, 'VALIDATION_ERROR', 'canonical', 'only canonical trust receipts may set canonical=true');
  }

  return createResult(ATP_OBJECT_TYPES.trustReceipt, warnings, errors);
}

function validateCausalChain(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'causal chain must be an object');
    return createResult(ATP_OBJECT_TYPES.causalChain, warnings, errors);
  }

  pushRequiredString(errors, object, 'start');
  pushRequiredArray(errors, object, 'chain');
  pushRequiredArray(errors, object, 'visited');
  pushRequiredArray(errors, object, 'loops');
  pushRequiredString(errors, object, 'stoppedReason');
  if (!Number.isInteger(object.maxDepth) || object.maxDepth < 0) {
    pushError(errors, 'VALIDATION_ERROR', 'maxDepth', 'maxDepth must be a non-negative integer');
  }
  validateConfidence(errors, object.confidence, 'confidence');
  pushRequiredArray(errors, object, 'evidence');

  for (const [index, step] of (Array.isArray(object.chain) ? object.chain.entries() : [])) {
    if (!isPlainObject(step)) {
      pushError(errors, 'VALIDATION_ERROR', `chain[${index}]`, 'chain entries must be objects');
      continue;
    }
    pushRequiredString(errors, step, 'from');
    pushRequiredString(errors, step, 'relation');
    pushRequiredString(errors, step, 'to');
    if (step.relation && !CAUSAL_RELATIONS.has(step.relation)) {
      pushError(errors, 'VALIDATION_ERROR', `chain[${index}].relation`, 'relation is not a supported causal relation');
    }
    if (step.confidence !== undefined && step.confidence !== null) {
      validateConfidence(errors, step.confidence, `chain[${index}].confidence`);
    }
  }

  return createResult(ATP_OBJECT_TYPES.causalChain, warnings, errors);
}

function validateSimulationResult(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'simulation result must be an object');
    return createResult(ATP_OBJECT_TYPES.simulationResult, warnings, errors);
  }

  pushRequiredString(errors, object, 'mode');
  pushRequiredArray(errors, object, 'affectedNodes');
  pushRequiredArray(errors, object, 'causalChains');
  pushRequiredArray(errors, object, 'risks');
  validateConfidence(errors, object.confidence, 'confidence');
  pushRequiredString(errors, object, 'recommendation');
  pushRequiredArray(errors, object, 'evidence');
  pushRequiredArray(errors, object, 'unknowns');

  for (const [index, chain] of (Array.isArray(object.causalChains) ? object.causalChains.entries() : [])) {
    const validation = validateCausalChain(chain);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => ({
        code: error.code,
        field: `causalChains[${index}].${error.field || ''}`.replace(/\.$/, ''),
        message: error.message,
      })));
    }
  }

  for (const [index, risk] of (Array.isArray(object.risks) ? object.risks.entries() : [])) {
    if (isPlainObject(risk) && risk.level !== undefined && !RISK_LEVELS.has(risk.level)) {
      pushError(errors, 'VALIDATION_ERROR', `risks[${index}].level`, 'risk level is not supported');
    }
  }

  return createResult(ATP_OBJECT_TYPES.simulationResult, warnings, errors);
}

function validateErrorObject(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_ATP_OBJECT', '', 'error envelope must be an object');
    return createResult(ATP_OBJECT_TYPES.error, warnings, errors);
  }
  if (object.ok !== false) {
    pushError(errors, 'VALIDATION_ERROR', 'ok', 'ok must be false');
  }
  if (!isPlainObject(object.error)) {
    pushError(errors, 'VALIDATION_ERROR', 'error', 'error must be an object');
    return createResult(ATP_OBJECT_TYPES.error, warnings, errors);
  }
  const { error } = object;
  pushRequiredString(errors, error, 'code');
  pushRequiredString(errors, error, 'message');
  if (typeof error.code === 'string' && !ERROR_CODES.has(error.code)) {
    pushError(errors, 'VALIDATION_ERROR', 'error.code', 'error.code is not a supported ATP error code');
  }
  if (!isJsonSafe(error.details)) {
    pushError(errors, 'VALIDATION_ERROR', 'error.details', 'error.details must be JSON-safe');
  }
  return createResult(ATP_OBJECT_TYPES.error, warnings, errors);
}

function validateATPObject(type, object, opts = {}) {
  const normalizedType = String(type || '').trim();
  switch (normalizedType) {
    case ATP_OBJECT_TYPES.provenanceRecord:
      return validateProvenanceRecord(object, opts);
    case ATP_OBJECT_TYPES.auditEvent:
      return validateAuditEvent(object, opts);
    case ATP_OBJECT_TYPES.candidateClaim:
      return validateCandidateClaim(object, opts);
    case ATP_OBJECT_TYPES.conflictResult:
      return validateConflictResult(object, opts);
    case ATP_OBJECT_TYPES.verificationResult:
      return validateVerificationResult(object, opts);
    case ATP_OBJECT_TYPES.trustReceipt:
      return validateTrustReceipt(object, opts);
    case ATP_OBJECT_TYPES.causalChain:
      return validateCausalChain(object, opts);
    case ATP_OBJECT_TYPES.simulationResult:
      return validateSimulationResult(object, opts);
    case ATP_OBJECT_TYPES.error:
      return validateErrorObject(object, opts);
    default:
      return createResult(normalizedType || 'unknown', [], [{
        code: 'INVALID_ATP_OBJECT',
        field: 'type',
        message: `Unknown ATP object type: ${normalizedType}`,
      }]);
  }
}

function validateATPFixture(type, filePath, opts = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return validateATPObject(type, parsed, opts);
  } catch (error) {
    return {
      ok: false,
      type,
      warnings: [],
      errors: [normalizeATPValidationError(error, 'file')],
    };
  }
}

function runATPConformance(fixtures = [], opts = {}) {
  const items = Array.isArray(fixtures) ? fixtures : [fixtures];
  const results = [];
  const warnings = [];
  const errors = [];

  for (const item of items) {
    const descriptor = typeof item === 'string' ? { filePath: item, type: opts.type } : item || {};
    const filePath = descriptor.filePath || descriptor.path || '';
    const type = descriptor.type || opts.type || '';
    const validation = validateATPFixture(type, filePath, opts);
    const result = {
      filePath,
      ...validation,
    };
    results.push(result);
    warnings.push(...validation.warnings);
    if (!validation.ok) {
      errors.push(...validation.errors.map((entry) => ({
        filePath,
        type,
        ...entry,
      })));
    }
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    results,
  };
}

module.exports = {
  ATP_OBJECT_TYPES,
  validateATPObject,
  validateATPFixture,
  runATPConformance,
  normalizeATPValidationError,
};
