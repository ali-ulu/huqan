// #2174: validating one memory record, event or link.

const { isPlainObject } = require('./is-plain-object');
const { isJsonSafe, pushError, result, validateProvenance, validateRequiredObject, validateRequiredString, validateTimestamp } = require('./memory-schema-checks');
const { MEMORY_EVENT_TYPES, MEMORY_LINK_RELATIONS, MEMORY_OBJECT_TYPES, MEMORY_STATUSES, validateSchemaVersion } = require('./memory-schema-types');

function validateMemoryRecord(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_MEMORY_OBJECT', '', 'memory record must be an object');
    return result(MEMORY_OBJECT_TYPES.memoryRecord, warnings, errors);
  }

  validateRequiredString(errors, object, 'memoryId');
  validateRequiredString(errors, object, 'workspaceId');
  validateRequiredString(errors, object, 'createdAt');
  validateRequiredObject(errors, object, 'provenance');
  validateRequiredString(errors, object, 'trustPolicyVersion');
  validateTimestamp(errors, object.createdAt, 'createdAt');
  if (object.updatedAt !== undefined && object.updatedAt !== null && object.updatedAt !== '') {
    validateTimestamp(errors, object.updatedAt, 'updatedAt');
  }
  if (object.deletedAt !== undefined && object.deletedAt !== null && object.deletedAt !== '') {
    validateTimestamp(errors, object.deletedAt, 'deletedAt');
  }
  if (object.content === undefined || object.content === null) {
    pushError(errors, 'VALIDATION_ERROR', 'content', 'content is required');
  } else if (!isJsonSafe(object.content)) {
    pushError(errors, 'VALIDATION_ERROR', 'content', 'content must be JSON-safe');
  }
  if (object.supersedesMemoryId !== undefined && object.supersedesMemoryId !== null && typeof object.supersedesMemoryId !== 'string') {
    pushError(errors, 'VALIDATION_ERROR', 'supersedesMemoryId', 'supersedesMemoryId must be a string when present');
  }
  if (object.status !== undefined && object.status !== null && !MEMORY_STATUSES.includes(object.status)) {
    pushError(errors, 'VALIDATION_ERROR', 'status', 'status is not a supported memory status');
  }
  if (object.provenance) validateProvenance(object.provenance, errors, 'provenance');
  if (object.metadata !== undefined && object.metadata !== null && !isJsonSafe(object.metadata)) {
    pushError(errors, 'VALIDATION_ERROR', 'metadata', 'metadata must be JSON-safe');
  }
  // PR-S5: schemaVersion check (A1 missing->warn, B1 newer->warn, invalid->error)
  validateSchemaVersion(object.schemaVersion, errors, warnings, 'memoryRecord');

  return result(MEMORY_OBJECT_TYPES.memoryRecord, warnings, errors);
}

function validateMemoryEvent(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_MEMORY_OBJECT', '', 'memory event must be an object');
    return result(MEMORY_OBJECT_TYPES.memoryEvent, warnings, errors);
  }

  validateRequiredString(errors, object, 'eventId');
  validateRequiredString(errors, object, 'eventType');
  validateRequiredString(errors, object, 'memoryId');
  validateRequiredString(errors, object, 'workspaceId');
  validateRequiredString(errors, object, 'createdAt');
  validateRequiredString(errors, object, 'actor');
  validateRequiredObject(errors, object, 'provenance');
  validateRequiredString(errors, object, 'trustPolicyVersion');
  validateRequiredObject(errors, object, 'details');
  validateTimestamp(errors, object.createdAt, 'createdAt');
  if (object.reviewedAt !== undefined && object.reviewedAt !== null && object.reviewedAt !== '') {
    validateTimestamp(errors, object.reviewedAt, 'reviewedAt');
  }
  if (object.eventType && !MEMORY_EVENT_TYPES.includes(object.eventType)) {
    pushError(errors, 'VALIDATION_ERROR', 'eventType', 'eventType is not a supported memory event type');
  }
  if (object.provenance) validateProvenance(object.provenance, errors, 'provenance');
  if (!isJsonSafe(object.details)) {
    pushError(errors, 'VALIDATION_ERROR', 'details', 'details must be JSON-safe');
  }
  // PR-S5: schemaVersion check (A1 missing->warn, B1 newer->warn, invalid->error)
  validateSchemaVersion(object.schemaVersion, errors, warnings, 'memoryEvent');

  return result(MEMORY_OBJECT_TYPES.memoryEvent, warnings, errors);
}

function validateMemoryLink(object) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_MEMORY_OBJECT', '', 'memory link must be an object');
    return result(MEMORY_OBJECT_TYPES.memoryLink, warnings, errors);
  }

  validateRequiredString(errors, object, 'linkId');
  validateRequiredString(errors, object, 'relation');
  validateRequiredString(errors, object, 'fromMemoryId');
  validateRequiredString(errors, object, 'toMemoryId');
  validateRequiredString(errors, object, 'workspaceId');
  validateRequiredString(errors, object, 'createdAt');
  validateRequiredObject(errors, object, 'provenance');
  validateRequiredString(errors, object, 'trustPolicyVersion');
  validateTimestamp(errors, object.createdAt, 'createdAt');
  if (!MEMORY_LINK_RELATIONS.includes(object.relation)) {
    pushError(errors, 'VALIDATION_ERROR', 'relation', 'relation is not a supported memory link relation');
  }
  if (object.strength !== undefined && object.strength !== null) {
    const strength = Number(object.strength);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      pushError(errors, 'VALIDATION_ERROR', 'strength', 'strength must be a number between 0 and 1');
    }
  }
  if (object.provenance) validateProvenance(object.provenance, errors, 'provenance');
  if (object.metadata !== undefined && object.metadata !== null && !isJsonSafe(object.metadata)) {
    pushError(errors, 'VALIDATION_ERROR', 'metadata', 'metadata must be JSON-safe');
  }
  // PR-S5: schemaVersion check (A1 missing->warn, B1 newer->warn, invalid->error)
  validateSchemaVersion(object.schemaVersion, errors, warnings, 'memoryLink');

  return result(MEMORY_OBJECT_TYPES.memoryLink, warnings, errors);
}

module.exports = {
  validateMemoryEvent,
  validateMemoryLink,
  validateMemoryRecord,
};
