'use strict';

// #3493 (R38): the reversible archive/restore pair for a stored memory.
//
// Delegated from lib/memory-store.js exactly as lib/memory-tombstone.js is
// (#328 MS): this module owns input normalization, event construction and the
// state precondition; persistence and mutation of store-owned state stay
// behind ArchiveStoreApi.
//
// Archive is NOT tombstone. Tombstone soft-deletes; archive *offloads* a record
// out of the default read set while keeping it fully restorable. The status
// machine is explicit and fail-closed:
//   archive: active | superseded -> archived   (anything else is refused)
//   restore: archived            -> active     (anything else is refused)
// A refused transition mutates nothing and appends no event, so an audited
// archive can never describe a mutation that did not happen.
//
// Visibility is the read side's job (lib/memory-record-visibility.js): an
// archived record disappears from default list/get/query/search/export and is
// reachable only with `includeArchived: true`. This module never writes to a
// read path.

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
const { isArchived } = require('./memory-record-visibility');

/**
 * Store API required by runArchive / runRestore.
 *
 * @typedef {object} ArchiveStoreApi
 * @property {Function} findMemory - (memoryId, workspaceId) => record | undefined
 * @property {Function} persist - (opts, payload) => undefined | {ok:false,error:object}
 * @property {Function} setStatus - (record, status, now) => undefined
 * @property {Function} appendEvent - event => undefined
 */

const ARCHIVABLE_STATUSES = Object.freeze(['active', 'superseded']);

function buildEvent(eventType, record, memoryId, now, actor, trustPolicyVersion, provenance, action) {
  const event = {
    eventId: generateEventId(),
    eventType,
    memoryId,
    workspaceId: record.workspaceId,
    createdAt: now,
    actor,
    provenance,
    trustPolicyVersion,
    details: { action },
  };
  event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;
  return event;
}

function resolveTarget(storeApi, memoryId, opts) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }
  const wid = normalizeWorkspaceId(opts.workspaceId);
  const record = storeApi.findMemory(memoryId, wid);
  if (!record) {
    return { error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
  }
  if (wid && record.workspaceId !== wid) {
    return { error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
  }
  return { record };
}

/**
 * Archive a memory: reversible offload out of the default read set.
 *
 * @param {ArchiveStoreApi} storeApi
 * @param {string} memoryId
 * @param {object} opts - { actor?, workspaceId?, trustPolicyVersion?, provenance? }
 * @returns {{ok:boolean,memory?:object,event?:object,error?:object}}
 */
function runArchive(storeApi, memoryId, opts = {}) {
  const target = resolveTarget(storeApi, memoryId, opts);
  if (target.error) return { ok: false, error: target.error };
  const { record } = target;

  if (!ARCHIVABLE_STATUSES.includes(record.status)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_STATUS_TRANSITION',
        message: `memory ${memoryId} is '${record.status}'; only ${ARCHIVABLE_STATUSES.join('/')} can be archived`,
      },
    };
  }

  const now = new Date().toISOString();
  const actor = opts.actor || 'system';
  const trustPolicyVersion = opts.trustPolicyVersion || record.trustPolicyVersion;
  const provenance = opts.provenance || makeProvenance(actor, record.workspaceId, trustPolicyVersion);
  const event = buildEvent('ARCHIVE', record, memoryId, now, actor, trustPolicyVersion, provenance, 'archive');

  const eventValidation = validateMemoryEvent(event);
  if (!eventValidation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'event validation failed', details: eventValidation.errors } };
  }

  const persistResult = storeApi.persist(opts, { record, event, now });
  if (persistResult && persistResult.ok === false) return persistResult;

  storeApi.setStatus(record, 'archived', now);
  storeApi.appendEvent(event);

  return { ok: true, memory: cloneMemoryRecord(record), event: cloneMemoryEvent(event) };
}

/**
 * Restore an archived memory back to 'active'. Reversible inverse of archive;
 * refuses any record that is not currently archived.
 *
 * @param {ArchiveStoreApi} storeApi
 * @param {string} memoryId
 * @param {object} opts - { actor?, workspaceId?, trustPolicyVersion?, provenance? }
 * @returns {{ok:boolean,memory?:object,event?:object,error?:object}}
 */
function runRestore(storeApi, memoryId, opts = {}) {
  const target = resolveTarget(storeApi, memoryId, opts);
  if (target.error) return { ok: false, error: target.error };
  const { record } = target;

  if (!isArchived(record)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_STATUS_TRANSITION',
        message: `memory ${memoryId} is '${record.status}'; only 'archived' can be restored`,
      },
    };
  }

  const now = new Date().toISOString();
  const actor = opts.actor || 'system';
  const trustPolicyVersion = opts.trustPolicyVersion || record.trustPolicyVersion;
  const provenance = opts.provenance || makeProvenance(actor, record.workspaceId, trustPolicyVersion);
  const event = buildEvent('RESTORE', record, memoryId, now, actor, trustPolicyVersion, provenance, 'restore');

  const eventValidation = validateMemoryEvent(event);
  if (!eventValidation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'event validation failed', details: eventValidation.errors } };
  }

  const persistResult = storeApi.persist(opts, { record, event, now });
  if (persistResult && persistResult.ok === false) return persistResult;

  storeApi.setStatus(record, 'active', now);
  storeApi.appendEvent(event);

  return { ok: true, memory: cloneMemoryRecord(record), event: cloneMemoryEvent(event) };
}

module.exports = { runArchive, runRestore, ARCHIVABLE_STATUSES };
