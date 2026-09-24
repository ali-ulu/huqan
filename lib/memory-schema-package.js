// #2174: validating a memory package as a whole, and the evolution from a
// previous record to the next.

const { isDeepStrictEqual } = require('util');
const { isPlainObject } = require('./is-plain-object');
const { isJsonSafe, pushError, result, validateRequiredArray, validateRequiredString } = require('./memory-schema-checks');
const { MEMORY_OBJECT_TYPES } = require('./memory-schema-types');
const { validateMemoryEvent, validateMemoryLink, validateMemoryRecord } = require('./memory-schema-validate');

function validateMemoryPackage(object, options = {}) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(object)) {
    pushError(errors, 'INVALID_MEMORY_OBJECT', '', 'memory package must be an object');
    return result(MEMORY_OBJECT_TYPES.memoryPackage, warnings, errors);
  }

  validateRequiredString(errors, object, 'version');
  validateRequiredString(errors, object, 'workspaceId');
  validateRequiredArray(errors, object, 'memories');
  validateRequiredArray(errors, object, 'events');
  validateRequiredArray(errors, object, 'links');
  if (object.metadata !== undefined && object.metadata !== null && !isJsonSafe(object.metadata)) {
    pushError(errors, 'VALIDATION_ERROR', 'metadata', 'metadata must be JSON-safe');
  }

  for (const [index, record] of (Array.isArray(object.memories) ? object.memories : []).entries()) {
    const validation = validateMemoryRecord(record);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => ({ ...error, field: `memories[${index}].${error.field}` })));
    }
  }
  for (const [index, event] of (Array.isArray(object.events) ? object.events : []).entries()) {
    const validation = validateMemoryEvent(event);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => ({ ...error, field: `events[${index}].${error.field}` })));
    }
  }
  for (const [index, link] of (Array.isArray(object.links) ? object.links : []).entries()) {
    const validation = validateMemoryLink(link);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => ({ ...error, field: `links[${index}].${error.field}` })));
    }
  }

  if (options.checkReferences !== false) {
    const memoryIds = new Set((Array.isArray(object.memories) ? object.memories : [])
      .map((record) => record?.memoryId)
      .filter((memoryId) => typeof memoryId === 'string' && memoryId.trim()));
    for (const [index, event] of (Array.isArray(object.events) ? object.events : []).entries()) {
      if (typeof event?.memoryId === 'string' && event.memoryId.trim() && !memoryIds.has(event.memoryId)) {
        pushError(errors, 'REFERENTIAL_INTEGRITY', `events[${index}].memoryId`,
          `event references memory ${event.memoryId}, which is not present in the package`);
      }
      if (typeof event?.relatedMemoryId === 'string' && event.relatedMemoryId.trim()
        && !memoryIds.has(event.relatedMemoryId)) {
        pushError(errors, 'REFERENTIAL_INTEGRITY', `events[${index}].relatedMemoryId`,
          `event relatedMemoryId ${event.relatedMemoryId} is not present in the package`);
      }
    }
    for (const [index, link] of (Array.isArray(object.links) ? object.links : []).entries()) {
      if (typeof link?.fromMemoryId === 'string' && link.fromMemoryId.trim()
        && !memoryIds.has(link.fromMemoryId)) {
        pushError(errors, 'REFERENTIAL_INTEGRITY', `links[${index}].fromMemoryId`,
          `link fromMemoryId ${link.fromMemoryId} is not present in the package`);
      }
      if (typeof link?.toMemoryId === 'string' && link.toMemoryId.trim()
        && !memoryIds.has(link.toMemoryId)) {
        pushError(errors, 'REFERENTIAL_INTEGRITY', `links[${index}].toMemoryId`,
          `link toMemoryId ${link.toMemoryId} is not present in the package`);
      }
    }
  }

  return result(MEMORY_OBJECT_TYPES.memoryPackage, warnings, errors);
}

/**
 * Validate one side of an evolution pair and merge its findings into the
 * evolution result, namespaced by which side produced them.
 *
 * @param {object} record
 * @param {'previous'|'next'} side
 * @param {string[]} warnings
 * @param {object[]} errors
 */
function collectRecordFindings(record, side, warnings, errors) {
  const validation = validateMemoryRecord(record);
  for (const error of validation.errors || []) {
    errors.push({ ...error, field: error.field ? `${side}.${error.field}` : side });
  }
  for (const warning of validation.warnings || []) {
    warnings.push(`${side}: ${warning}`);
  }
}

function validateMemoryEvolution(previous, next) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    pushError(errors, 'INVALID_MEMORY_OBJECT', '', 'memory evolution must compare two objects');
    return result(MEMORY_OBJECT_TYPES.memoryEvolution, warnings, errors);
  }

  // Both records are validated as records first, and their findings are kept.
  // Calling these for their return value and discarding it made the evolution
  // surface fail-open: two empty objects carry no memoryId, so neither the
  // IMMUTABLE_CONTENT nor the SUPERCEDES_REQUIRED branch below can fire, and
  // the whole check answered ok:true. The side is prefixed onto the field so a
  // caller can tell which record produced the error.
  collectRecordFindings(previous, 'previous', warnings, errors);
  collectRecordFindings(next, 'next', warnings, errors);

  if (previous.memoryId && next.memoryId && previous.memoryId === next.memoryId && !isDeepStrictEqual(previous.content, next.content)) {
    pushError(errors, 'IMMUTABLE_CONTENT', 'content', 'memory content is immutable; content changes require a new memory record');
  }

  if (!isDeepStrictEqual(previous.content, next.content)) {
    if (!next.supersedesMemoryId) {
      pushError(errors, 'SUPERCEDES_REQUIRED', 'supersedesMemoryId', 'content changes require a supersedesMemoryId link to the prior memory');
    } else if (previous.memoryId && next.supersedesMemoryId !== previous.memoryId) {
      pushError(errors, 'SUPERCEDES_REQUIRED', 'supersedesMemoryId', 'supersedesMemoryId must point at the prior memory record');
    }
  }

  if (next.deletedAt && !next.supersedesMemoryId) {
    warnings.push('deleted memory records should also be represented by a tombstone event');
  }

  return result(MEMORY_OBJECT_TYPES.memoryEvolution, warnings, errors);
}

module.exports = {
  collectRecordFindings,
  validateMemoryEvolution,
  validateMemoryPackage,
};
