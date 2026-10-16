'use strict';

// Delegated from lib/memory-store.js (MemoryStore.tombstone) by #328 MS.
// This module owns input normalization, event construction, and validation.
// Persistence and mutation of store-owned state remain behind TombstoneStoreApi.
const {
  validateMemoryEvent,
  MEMORY_SCHEMA_VERSIONS,
} = require('./memory-schema');
const {
  makeProvenance,
  generateEventId,
  normalizeWorkspaceId,
} = require('./memory-store-utils');
const { cloneMemoryRecord, cloneMemoryEvent } = require('./memory-record-utils');

/**
 * Store API required by runTombstone.
 *
 * @typedef {object} TombstoneStoreApi
 * @property {Function} findMemory - (memoryId, workspaceId) => record | undefined
 * @property {Function} persist - (opts, payload) => undefined | {ok:false,error:object}
 * @property {Function} markDeleted - (record, now) => undefined
 * @property {Function} appendEvent - event => undefined
 */

/**
 * Tombstone a memory without physically deleting it.
 *
 * @param {TombstoneStoreApi} storeApi
 * @param {string} memoryId
 * @param {object} opts - { actor?, workspaceId?, trustPolicyVersion?, provenance? }
 * @returns {{ok:boolean,memory?:object,event?:object,error?:object}}
 */
function runTombstone(storeApi, memoryId, opts = {}) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }

  const wid = normalizeWorkspaceId(opts.workspaceId);
  const record = storeApi.findMemory(memoryId, wid);
  if (!record) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
  }

  if (wid && record.workspaceId !== wid) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
  }

  const now = new Date().toISOString();
  const actor = opts.actor || 'system';
  const trustPolicyVersion = opts.trustPolicyVersion || record.trustPolicyVersion;
  const provenance = opts.provenance || makeProvenance(actor, record.workspaceId, trustPolicyVersion);

  const event = {
    eventId: generateEventId(),
    eventType: 'TOMBSTONE',
    memoryId,
    workspaceId: record.workspaceId,
    createdAt: now,
    actor,
    provenance,
    trustPolicyVersion,
    details: { action: 'tombstone' },
  };
  // PR-S5
  event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

  const eventValidation = validateMemoryEvent(event);
  if (!eventValidation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'event validation failed', details: eventValidation.errors } };
  }

  const persistResult = storeApi.persist(opts, { record, event, now });
  if (persistResult && persistResult.ok === false) {
    return persistResult;
  }

  storeApi.markDeleted(record, now);
  storeApi.appendEvent(event);

  return { ok: true, memory: cloneMemoryRecord(record), event: cloneMemoryEvent(event) };
}

module.exports = { runTombstone };
