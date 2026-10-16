'use strict';

/**
 * Delegated from MemoryStore#store by #328 MS.
 *
 * This module owns input guards, record/event construction, schema validation,
 * and the returned defensive copies. The MemoryStore store API retains SQLite
 * persistence, transaction/rollback handling, and mutation of its owned
 * collections. Persistence is called before the in-memory record/event mutation.
 */
const {
  MEMORY_SCHEMA_VERSIONS,
  normalizeMemoryRecord,
  validateMemoryRecord,
} = require('./memory-schema');
const {
  makeProvenance,
  normalizeWorkspaceId,
  generateMemoryId,
  generateEventId,
} = require('./memory-store-utils');
const { cloneMemoryRecord, cloneMemoryEvent } = require('./memory-record-utils');

/**
 * Store API required by runStore.
 *
 * @typedef {object} StoreWriteApi
 * @property {string} defaultTrustPolicyVersion
 * @property {Function} persist - (record, event) => {ok?: boolean, error?: object}
 * @property {Function} remember - (record, event) => undefined
 */

function runStore(storeApi, input = {}) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'input must be an object' } };
  }
  if (input.content === undefined || input.content === null) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'content is required' } };
  }
  if (typeof input.content === 'string' && input.content.trim() === '') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'content must not be empty or whitespace' } };
  }

  const now = new Date().toISOString();
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const trustPolicyVersion = input.trustPolicyVersion || storeApi.defaultTrustPolicyVersion;
  const actor = input.actor || 'system';
  const provenance = input.provenance || makeProvenance(actor, workspaceId, trustPolicyVersion);
  const memoryId = generateMemoryId(input.content, workspaceId, now);
  const record = normalizeMemoryRecord({
    memoryId,
    workspaceId,
    content: JSON.parse(JSON.stringify(input.content)),
    createdAt: now,
    provenance,
    trustPolicyVersion,
    status: 'active',
    metadata: input.metadata || {},
  });
  // PR-S5: stamp schemaVersion on every freshly written record.
  record.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryRecord;
  const validation = validateMemoryRecord(record);
  if (!validation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory record failed validation', details: validation.errors } };
  }

  const event = {
    eventId: generateEventId(),
    eventType: 'CREATED',
    memoryId,
    workspaceId,
    createdAt: now,
    actor,
    provenance,
    trustPolicyVersion,
    details: { action: 'store' },
  };
  // PR-S5: stamp schemaVersion on every freshly written event.
  event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

  const persistence = storeApi.persist(record, event);
  if (persistence && persistence.ok === false) return persistence;

  storeApi.remember(record, event);
  return { ok: true, memory: cloneMemoryRecord(record), event: cloneMemoryEvent(event) };
}

module.exports = { runStore };
