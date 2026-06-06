const { isDeepStrictEqual } = require('util');

const MEMORY_OBJECT_TYPES = Object.freeze({
  memoryRecord: 'memory-record',
  memoryEvent: 'memory-event',
  memoryLink: 'memory-link',
  memoryPackage: 'memory-package',
  memoryEvolution: 'memory-evolution',
});

const MEMORY_EVENT_TYPES = Object.freeze([
  'CREATED',
  'UPDATED',
  'DELETED',
  'TOMBSTONE',
  'LINKED',
  'UNLINKED',
  'IMPORTED',
  'EXPORTED',
  'REVIEWED',
]);

const MEMORY_LINK_RELATIONS = Object.freeze([
  'supersedes',
  'contradicts',
  'supports',
  'references',
  'related_to',
]);

const MEMORY_STATUSES = Object.freeze([
  'active',
  'superseded',
  'deleted',
  'archived',
  'unknown',
]);

// PR-S5: schema versioning constants + helpers.
// Per-record schemaVersion. memoryPackage.version is reserved for the
// package/protocol version and is intentionally separate from this field.
const MEMORY_SCHEMA_VERSIONS = Object.freeze({
  memoryRecord: '1.0.0',
  memoryEvent: '1.0.0',
  memoryLink: '1.0.0',
  memoryPackage: '1.0.0',
});

// Minimal local semver compare (no npm dependency). Returns -1, 0, or 1.
// Pre-release suffix is ignored (treated as the base version).
function compareSemver(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// A1 (missing -> warning, OK) + B1 (newer -> warning, OK).
// Invalid (non-string, empty) -> error, FAIL.
function validateSchemaVersion(version, errors, warnings, type) {
  if (version === undefined || version === null) {
    warnings.push({
      code: 'SCHEMA_VERSION_MISSING',
      field: 'schemaVersion',
      message: `${type} record has no schemaVersion; defaults to ${MEMORY_SCHEMA_VERSIONS[type]} on next write`,
    });
    return true;
  }
  if (typeof version !== 'string' || !version.trim()) {
    pushError(errors, 'VALIDATION_ERROR', 'schemaVersion',
      'schemaVersion must be a non-empty string');
    return false;
  }
  const known = MEMORY_SCHEMA_VERSIONS[type];
  if (version === known) return true;
  const cmp = compareSemver(version, known);
  if (cmp < 0) {
    warnings.push({
      code: 'SCHEMA_VERSION_OLDER',
      field: 'schemaVersion',
      message: `${type} schemaVersion=${version} is older than known=${known}`,
    });
  } else {
    warnings.push({
      code: 'SCHEMA_VERSION_NEWER',
      field: 'schemaVersion',
      message: `${type} schemaVersion=${version} is newer than known=${known}`,
    });
  }
  return true;
}

const MEMORY_SCHEMAS = Object.freeze({
  memoryRecord: Object.freeze({
    type: 'object',
    required: ['memoryId', 'workspaceId', 'content', 'createdAt', 'provenance', 'trustPolicyVersion'],
    properties: Object.freeze({
      memoryId: { type: 'string' },
      workspaceId: { type: 'string' },
      content: { type: 'any-json-safe' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time', optional: true },
      deletedAt: { type: 'string', format: 'date-time', optional: true },
      supersedesMemoryId: { type: 'string', optional: true },
      provenance: { type: 'object' },
      trustPolicyVersion: { type: 'string' },
      status: { type: 'string', enum: MEMORY_STATUSES, optional: true },
      metadata: { type: 'any-json-safe', optional: true },
    }),
  }),
  memoryEvent: Object.freeze({
    type: 'object',
    required: ['eventId', 'eventType', 'memoryId', 'workspaceId', 'createdAt', 'actor', 'provenance', 'trustPolicyVersion', 'details'],
    properties: Object.freeze({
      eventId: { type: 'string' },
      eventType: { type: 'string', enum: MEMORY_EVENT_TYPES },
      memoryId: { type: 'string' },
      workspaceId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      actor: { type: 'string' },
      provenance: { type: 'object' },
      trustPolicyVersion: { type: 'string' },
      details: { type: 'any-json-safe' },
      reviewedAt: { type: 'string', format: 'date-time', optional: true },
      reviewedBy: { type: 'string', optional: true },
      relatedMemoryId: { type: 'string', optional: true },
    }),
  }),
  memoryLink: Object.freeze({
    type: 'object',
    required: ['linkId', 'relation', 'fromMemoryId', 'toMemoryId', 'workspaceId', 'createdAt', 'provenance', 'trustPolicyVersion'],
    properties: Object.freeze({
      linkId: { type: 'string' },
      relation: { type: 'string', enum: MEMORY_LINK_RELATIONS },
      fromMemoryId: { type: 'string' },
      toMemoryId: { type: 'string' },
      workspaceId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      provenance: { type: 'object' },
      trustPolicyVersion: { type: 'string' },
      strength: { type: 'number', min: 0, max: 1, optional: true },
      metadata: { type: 'any-json-safe', optional: true },
    }),
  }),
  memoryPackage: Object.freeze({
    type: 'object',
    required: ['version', 'workspaceId', 'memories', 'events', 'links'],
    properties: Object.freeze({
      version: { type: 'string' },
      workspaceId: { type: 'string' },
      memories: { type: 'array' },
      events: { type: 'array' },
      links: { type: 'array' },
      metadata: { type: 'any-json-safe', optional: true },
    }),
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeWorkspaceId(workspaceId) {
  return String(workspaceId || 'default').trim() || 'default';
}

function isJsonSafe(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch (_) {
    return false;
  }
}

function pushError(errors, code, field, message) {
  errors.push({ code, field, message });
}

function result(type, warnings, errors) {
  return { ok: errors.length === 0, type, warnings, errors };
}

function validateTimestamp(errors, value, field) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} must be a parseable timestamp`);
    return false;
  }
  return true;
}

function validateRequiredString(errors, object, field) {
  if (!isPlainObject(object) || typeof object[field] !== 'string' || !object[field].trim()) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} is required`);
    return false;
  }
  return true;
}

function validateRequiredObject(errors, object, field) {
  if (!isPlainObject(object) || !isPlainObject(object[field])) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} is required`);
    return false;
  }
  return true;
}

function validateRequiredArray(errors, object, field) {
  if (!isPlainObject(object) || !Array.isArray(object[field])) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} is required`);
    return false;
  }
  return true;
}

function validateProvenance(provenance, errors, fieldPrefix = 'provenance') {
  if (!validateRequiredObject(errors, { provenance }, 'provenance')) return false;
  validateRequiredString(errors, provenance, 'provenanceId');
  validateRequiredString(errors, provenance, 'sourceRef');
  validateRequiredString(errors, provenance, 'sourceTitle');
  validateRequiredString(errors, provenance, 'sourceType');
  validateRequiredString(errors, provenance, 'actor');
  validateRequiredString(errors, provenance, 'timestamp');
  validateRequiredString(errors, provenance, 'workspaceId');
  validateRequiredString(errors, provenance, 'trustPolicyVersion');
  validateTimestamp(errors, provenance.timestamp, `${fieldPrefix}.timestamp`);
  if (typeof provenance.confidence !== 'number' || Number.isNaN(provenance.confidence) || provenance.confidence < 0 || provenance.confidence > 1) {
    pushError(errors, 'VALIDATION_ERROR', `${fieldPrefix}.confidence`, `${fieldPrefix}.confidence must be a number between 0 and 1`);
  }
  if (!isJsonSafe(provenance.metadata ?? null)) {
    pushError(errors, 'VALIDATION_ERROR', `${fieldPrefix}.metadata`, `${fieldPrefix}.metadata must be JSON-safe`);
  }
  return true;
}

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

function validateMemoryPackage(object) {
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

  return result(MEMORY_OBJECT_TYPES.memoryPackage, warnings, errors);
}

function validateMemoryEvolution(previous, next) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    pushError(errors, 'INVALID_MEMORY_OBJECT', '', 'memory evolution must compare two objects');
    return result(MEMORY_OBJECT_TYPES.memoryEvolution, warnings, errors);
  }

  validateMemoryRecord(previous);
  validateMemoryRecord(next);

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

function normalizeMemoryRecord(record = {}) {
  const next = clone(record) || {};
  if (next.workspaceId !== undefined) next.workspaceId = normalizeWorkspaceId(next.workspaceId);
  else next.workspaceId = 'default';
  if (next.trustPolicyVersion !== undefined && next.trustPolicyVersion !== null) next.trustPolicyVersion = String(next.trustPolicyVersion).trim();
  if (next.memoryId !== undefined && next.memoryId !== null) next.memoryId = String(next.memoryId).trim();
  if (next.createdAt !== undefined && next.createdAt !== null) next.createdAt = String(next.createdAt).trim();
  if (next.updatedAt !== undefined && next.updatedAt !== null) next.updatedAt = String(next.updatedAt).trim();
  if (next.deletedAt !== undefined && next.deletedAt !== null) next.deletedAt = String(next.deletedAt).trim();
  if (next.supersedesMemoryId !== undefined && next.supersedesMemoryId !== null) next.supersedesMemoryId = String(next.supersedesMemoryId).trim();
  if (next.status !== undefined && next.status !== null) next.status = String(next.status).trim();
  if (next.provenance && isPlainObject(next.provenance)) {
    next.provenance = clone(next.provenance);
    next.provenance.workspaceId = normalizeWorkspaceId(next.provenance.workspaceId || next.workspaceId);
    if (next.provenance.provenanceId !== undefined && next.provenance.provenanceId !== null) {
      next.provenance.provenanceId = String(next.provenance.provenanceId).trim();
    }
    ['sourceRef', 'sourceTitle', 'sourceType', 'actor', 'timestamp', 'trustPolicyVersion'].forEach((field) => {
      if (next.provenance[field] !== undefined && next.provenance[field] !== null) {
        next.provenance[field] = String(next.provenance[field]).trim();
      }
    });
    if (next.provenance.confidence !== undefined && next.provenance.confidence !== null) {
      next.provenance.confidence = Number(next.provenance.confidence);
    }
  }
  return next;
}

function normalizeMemoryEvent(event = {}) {
  const next = clone(event) || {};
  if (next.workspaceId !== undefined) next.workspaceId = normalizeWorkspaceId(next.workspaceId);
  else next.workspaceId = 'default';
  ['eventId', 'eventType', 'memoryId', 'createdAt', 'actor', 'trustPolicyVersion', 'reviewedBy', 'relatedMemoryId'].forEach((field) => {
    if (next[field] !== undefined && next[field] !== null) next[field] = String(next[field]).trim();
  });
  if (next.provenance && isPlainObject(next.provenance)) {
    next.provenance = clone(next.provenance);
    next.provenance.workspaceId = normalizeWorkspaceId(next.provenance.workspaceId || next.workspaceId);
    if (next.provenance.trustPolicyVersion !== undefined && next.provenance.trustPolicyVersion !== null) {
      next.provenance.trustPolicyVersion = String(next.provenance.trustPolicyVersion).trim();
    }
  }
  return next;
}

function normalizeMemoryLink(link = {}) {
  const next = clone(link) || {};
  if (next.workspaceId !== undefined) next.workspaceId = normalizeWorkspaceId(next.workspaceId);
  else next.workspaceId = 'default';
  ['linkId', 'relation', 'fromMemoryId', 'toMemoryId', 'createdAt', 'trustPolicyVersion'].forEach((field) => {
    if (next[field] !== undefined && next[field] !== null) next[field] = String(next[field]).trim();
  });
  if (next.strength !== undefined && next.strength !== null) next.strength = Number(next.strength);
  if (next.provenance && isPlainObject(next.provenance)) {
    next.provenance = clone(next.provenance);
    next.provenance.workspaceId = normalizeWorkspaceId(next.provenance.workspaceId || next.workspaceId);
    if (next.provenance.trustPolicyVersion !== undefined && next.provenance.trustPolicyVersion !== null) {
      next.provenance.trustPolicyVersion = String(next.provenance.trustPolicyVersion).trim();
    }
  }
  return next;
}

module.exports = {
  MEMORY_EVENT_TYPES,
  MEMORY_LINK_RELATIONS,
  MEMORY_OBJECT_TYPES,
  MEMORY_SCHEMAS,
  MEMORY_SCHEMA_VERSIONS,
  MEMORY_STATUSES,
  compareSemver,
  normalizeMemoryEvent,
  normalizeMemoryEvolution: validateMemoryEvolution,
  normalizeMemoryLink,
  normalizeMemoryRecord,
  validateMemoryEvent,
  validateMemoryEvolution,
  validateMemoryLink,
  validateMemoryPackage,
  validateMemoryRecord,
  validateSchemaVersion,
};
