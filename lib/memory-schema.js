// The memory schema's public surface. Types and versions, field checks,
// record/event/link and package validation, and normalization live in
// memory-schema-*.js (#2174).

const { ensureMemoryEventRelatedMemoryColumn, normalizeMemoryEvent, normalizeMemoryLink, normalizeMemoryRecord } = require('./memory-schema-normalize');
const { validateMemoryEvolution, validateMemoryPackage } = require('./memory-schema-package');
const { MEMORY_EVENT_TYPES, MEMORY_LINK_RELATIONS, MEMORY_OBJECT_TYPES, MEMORY_SCHEMAS, MEMORY_SCHEMA_VERSIONS, MEMORY_STATUSES, compareSemver, validateSchemaVersion } = require('./memory-schema-types');
const { validateMemoryEvent, validateMemoryLink, validateMemoryRecord } = require('./memory-schema-validate');

module.exports = {
  MEMORY_EVENT_TYPES,
  MEMORY_LINK_RELATIONS,
  MEMORY_OBJECT_TYPES,
  MEMORY_SCHEMAS,
  MEMORY_SCHEMA_VERSIONS,
  ensureMemoryEventRelatedMemoryColumn,
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
