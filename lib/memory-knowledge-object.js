'use strict';

// #3470 (K0): the KnowledgeObject schema -- one record shape for every kind of
// thing the kernel knows: fact, rule, procedure, policy, capability, model and
// hypothesis. Each object carries id, version, provenance, dependencies,
// confidence, scope, status, supersedes and receipt.
//
// It reuses the memory schema instead of growing a second one: provenance,
// timestamps and JSON safety go through memory-schema-checks.js, status uses
// MEMORY_STATUSES and versions compare with compareSemver.
//
// Authority boundary: policy and capability objects define what may run, so a
// learned one is refused. `origin: 'learned'` is allowed for the other kinds;
// a policy or capability must be `authored` and, once active, carry a receipt.
// A version step (validateKnowledgeSupersession) may not change the kind, the
// workspace or the origin, so learning cannot promote itself into authority
// by superseding an authored policy or capability. Like I5's authorityDelta
// (#3469), `origin` is the writer's declaration; this schema stops a declared
// learned authority object, not one that lies about its origin.

const { isPlainObject } = require('./is-plain-object');
const { isJsonSafe, pushError, result, validateProvenance, validateRequiredObject, validateRequiredString } = require('./memory-schema-checks');
const { MEMORY_STATUSES, compareSemver } = require('./memory-schema-types');

const KNOWLEDGE_OBJECT_TYPE = 'knowledge-object';
const KNOWLEDGE_KINDS = Object.freeze(['fact', 'rule', 'procedure', 'policy', 'capability', 'model', 'hypothesis']);
const AUTHORITY_KINDS = Object.freeze(['policy', 'capability']);
const KNOWLEDGE_ORIGINS = Object.freeze(['authored', 'learned']);
const SEMVER = /^\d+\.\d+\.\d+$/;

function present(value) {
  return value !== undefined && value !== null;
}

function validateVersion(errors, value, field) {
  if (typeof value !== 'string' || !SEMVER.test(value)) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} must be a MAJOR.MINOR.PATCH version`);
  }
}

function validateConfidence(errors, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    pushError(errors, 'VALIDATION_ERROR', 'confidence', 'confidence must be a number between 0 and 1');
  }
}

function validateReference(errors, ref, field) {
  if (!isPlainObject(ref)) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} must be a { knowledgeId, version } reference`);
    return;
  }
  validateRequiredString(errors, ref, 'knowledgeId', `${field}.knowledgeId`);
  validateVersion(errors, ref.version, `${field}.version`);
}

function validateDependencies(errors, object) {
  if (!Array.isArray(object.dependencies)) {
    pushError(errors, 'VALIDATION_ERROR', 'dependencies', 'dependencies is required (an empty array when there are none)');
    return;
  }
  object.dependencies.forEach((ref, index) => {
    validateReference(errors, ref, `dependencies[${index}]`);
    if (isPlainObject(ref) && ref.knowledgeId === object.knowledgeId) {
      pushError(errors, 'VALIDATION_ERROR', `dependencies[${index}]`, 'a knowledge object cannot depend on itself');
    }
  });
}

function validateScope(errors, object) {
  if (!validateRequiredObject(errors, object, 'scope')) return;
  if (!validateRequiredString(errors, object.scope, 'workspaceId', 'scope.workspaceId')) return;
  if (object.scope.workspaceId !== object.workspaceId) {
    pushError(errors, 'VALIDATION_ERROR', 'scope.workspaceId', 'scope.workspaceId must equal workspaceId');
  }
}

function validateSupersedes(errors, object) {
  if (!present(object.supersedes)) return;
  validateReference(errors, object.supersedes, 'supersedes');
  const ref = object.supersedes;
  if (isPlainObject(ref) && ref.knowledgeId === object.knowledgeId && SEMVER.test(String(ref.version))
    && SEMVER.test(String(object.version)) && compareSemver(ref.version, object.version) >= 0) {
    pushError(errors, 'VALIDATION_ERROR', 'supersedes.version', 'supersedes must name an older version');
  }
}

function validateReceipt(errors, object) {
  if (!('receipt' in object)) {
    pushError(errors, 'VALIDATION_ERROR', 'receipt', 'receipt is required (null when none was issued)');
    return;
  }
  if (object.receipt === null) return;
  if (!isPlainObject(object.receipt)) {
    pushError(errors, 'VALIDATION_ERROR', 'receipt', 'receipt must be null or an object');
    return;
  }
  validateRequiredString(errors, object.receipt, 'receiptId', 'receipt.receiptId');
}

function validateAuthority(errors, object) {
  if (!AUTHORITY_KINDS.includes(object.kind)) return;
  if (object.origin === 'learned') {
    pushError(errors, 'AUTHORITY_EXPANSION_REFUSED', 'origin',
      `a ${object.kind} cannot be learned; it widens authority and must be authored`);
  }
  if (object.status === 'active' && !isPlainObject(object.receipt)) {
    pushError(errors, 'AUTHORITY_RECEIPT_REQUIRED', 'receipt', `an active ${object.kind} must carry a receipt`);
  }
}

function validateKnowledgeObject(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_KNOWLEDGE_OBJECT', '', 'knowledge object must be an object');
    return result(KNOWLEDGE_OBJECT_TYPE, warnings, errors);
  }
  validateRequiredString(errors, object, 'knowledgeId');
  validateRequiredString(errors, object, 'workspaceId');
  if (!KNOWLEDGE_KINDS.includes(object.kind)) {
    pushError(errors, 'VALIDATION_ERROR', 'kind', `kind must be one of ${KNOWLEDGE_KINDS.join(', ')}`);
  }
  if (!KNOWLEDGE_ORIGINS.includes(object.origin)) {
    pushError(errors, 'VALIDATION_ERROR', 'origin', `origin must be one of ${KNOWLEDGE_ORIGINS.join(', ')}`);
  }
  validateVersion(errors, object.version, 'version');
  if (!present(object.content) || !isJsonSafe(object.content)) {
    pushError(errors, 'VALIDATION_ERROR', 'content', 'content is required and must be JSON-safe');
  }
  if (validateRequiredObject(errors, object, 'provenance')) validateProvenance(object.provenance, errors, 'provenance');
  validateDependencies(errors, object);
  validateConfidence(errors, object.confidence);
  validateScope(errors, object);
  if (!MEMORY_STATUSES.includes(object.status)) {
    pushError(errors, 'VALIDATION_ERROR', 'status', 'status is not a supported memory status');
  }
  validateSupersedes(errors, object);
  validateReceipt(errors, object);
  validateAuthority(errors, object);
  return result(KNOWLEDGE_OBJECT_TYPE, warnings, errors);
}

// A version step from `previous` to `next`. Both must be valid on their own;
// the step must keep the id, kind, workspace and origin and name `previous` in
// `supersedes`. Moving forward follows: next's own check already requires its
// `supersedes` version to be older than its own.
function validateKnowledgeSupersession(previous, next) {
  const errors = [];
  const before = validateKnowledgeObject(previous);
  const after = validateKnowledgeObject(next);
  if (!before.ok) pushError(errors, 'INVALID_PREVIOUS', 'previous', 'previous is not a valid knowledge object');
  if (!after.ok) pushError(errors, 'INVALID_NEXT', 'next', 'next is not a valid knowledge object');
  if (errors.length) return { ...result(KNOWLEDGE_OBJECT_TYPE, [], errors), previous: before, next: after };

  for (const field of ['knowledgeId', 'kind', 'workspaceId']) {
    if (previous[field] !== next[field]) pushError(errors, 'SUPERSESSION_MISMATCH', field, `${field} cannot change across versions`);
  }
  if (previous.origin !== next.origin) {
    const code = [previous.kind, next.kind].some((kind) => AUTHORITY_KINDS.includes(kind)) ? 'AUTHORITY_EXPANSION_REFUSED' : 'SUPERSESSION_MISMATCH';
    pushError(errors, code, 'origin', 'origin cannot change across versions');
  }
  if (!isPlainObject(next.supersedes) || next.supersedes.knowledgeId !== previous.knowledgeId
    || next.supersedes.version !== previous.version) {
    pushError(errors, 'SUPERSESSION_MISMATCH', 'supersedes', 'next.supersedes must name previous by knowledgeId and version');
  }
  return result(KNOWLEDGE_OBJECT_TYPE, [], errors);
}

module.exports = Object.freeze({
  AUTHORITY_KINDS,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_OBJECT_TYPE,
  KNOWLEDGE_ORIGINS,
  validateKnowledgeObject,
  validateKnowledgeSupersession,
});
