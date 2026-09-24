// #2174: memory object types, event types, link relations, statuses, schema
// versions (with the semver comparison) and the per-type schema table.

const { pushError } = require('./memory-schema-checks');

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

module.exports = {
  MEMORY_EVENT_TYPES,
  MEMORY_LINK_RELATIONS,
  MEMORY_OBJECT_TYPES,
  MEMORY_SCHEMAS,
  MEMORY_SCHEMA_VERSIONS,
  MEMORY_STATUSES,
  compareSemver,
  validateSchemaVersion,
};
