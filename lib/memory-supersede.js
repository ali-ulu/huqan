'use strict';

// Delegated from lib/memory-store.js (MemoryStore.supersede) by #328 MS.
// The class method is now:
//   return runSupersede(this, oldMemoryId, newContent, opts);
//
// Context interface (documented, docs-first). The "store API" parameter must
// satisfy:
//   findMemory(memoryId, workspaceId) -> record | undefined  (store lookup)
//   persist(opts, ops)                  -> undefined           (storage layer;
//                                  ops are { newRecord, oldRecord, link,
//                                  event, oldMemoryUpdateEvent }; called
//                                  inside a transaction with rollback on
//                                  error when SQLite is present)
//   remember(record, key)               -> undefined           (in-memory
//                                  cache insert)
//   appendLinks(...links)               -> undefined           (event log)
//   appendEvents(...events)             -> undefined           (event log)
//   makeKey(workspaceId, memoryId)      -> string              (cache key)
// Mutating helpers (persist/remember/appendLinks/appendEvents) are invoked by
// the delegate ONLY after every validation decision succeeds, so validation
// never silently widens into a write (fail-closed).
const {
  validateMemoryRecord,
  validateMemoryEvent,
  normalizeMemoryRecord,
  MEMORY_SCHEMA_VERSIONS,
} = require('./memory-schema');
const {
  makeProvenance,
  getContentHash,
  generateMemoryId,
  generateLinkId,
  generateEventId,
  normalizeWorkspaceId,
} = require('./memory-store-utils');
const {
  cloneMemoryRecord,
  cloneMemoryLink,
  cloneMemoryEvent,
} = require('./memory-record-utils');

/**
 * Build the supersede payload (new record, link, events) and write through
 * the store API. Content is never overwritten; the old memory is marked
 * superseded.
 * @param {object} storeApi - the context interface documented above
 * @param {string} oldMemoryId
 * @param {*} newContent
 * @param {object} opts - { actor?, workspaceId?, metadata?, trustPolicyVersion?, provenance? }
 * @returns {{ ok: boolean, oldMemory?: object, newMemory?: object, link?: object, event?: object, oldMemoryUpdateEvent?: object, error?: object }}
 */
function runSupersede(storeApi, oldMemoryId, newContent, opts = {}) {
  if (!oldMemoryId || typeof oldMemoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'oldMemoryId is required' } };
  }
  if (newContent === undefined || newContent === null) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'newContent is required' } };
  }

  const wid = normalizeWorkspaceId(opts.workspaceId);
  const oldRecord = storeApi.findMemory(oldMemoryId, wid);
  if (!oldRecord) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${oldMemoryId} not found` } };
  }

  if (wid && oldRecord.workspaceId !== wid) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${oldMemoryId} not found in workspace ${wid}` } };
  }

  const now = new Date().toISOString();
  const actor = opts.actor || 'system';
  const trustPolicyVersion = opts.trustPolicyVersion || oldRecord.trustPolicyVersion;
  const workspaceId = oldRecord.workspaceId;
  const provenance = opts.provenance || makeProvenance(actor, workspaceId, trustPolicyVersion);
  const newMemoryId = generateMemoryId(newContent, workspaceId, now);

  const newRecord = normalizeMemoryRecord({
    memoryId: newMemoryId,
    workspaceId,
    content: JSON.parse(JSON.stringify(newContent)),
    createdAt: now,
    provenance,
    trustPolicyVersion,
    status: 'active',
    supersedesMemoryId: oldMemoryId,
    metadata: opts.metadata || {},
  });
  // PR-S5
  newRecord.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryRecord;

  const validation = validateMemoryRecord(newRecord);
  if (!validation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'new memory record failed validation', details: validation.errors } };
  }

  const link = {
    linkId: generateLinkId(),
    relation: 'supersedes',
    fromMemoryId: newMemoryId,
    toMemoryId: oldMemoryId,
    workspaceId,
    createdAt: now,
    provenance,
    trustPolicyVersion,
    strength: 1.0,
  };
  // PR-S5
  link.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryLink;

  const event = {
    eventId: generateEventId(),
    eventType: 'CREATED',
    memoryId: newMemoryId,
    workspaceId,
    createdAt: now,
    actor,
    provenance,
    trustPolicyVersion,
    details: { action: 'supersede', supersedesMemoryId: oldMemoryId },
    relatedMemoryId: oldMemoryId,
  };
  // PR-S5
  event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

  const oldPreviousStatus = oldRecord.status || 'active';
  const oldMemoryUpdateEvent = {
    eventId: generateEventId(),
    eventType: 'UPDATED',
    memoryId: oldMemoryId,
    workspaceId,
    createdAt: now,
    actor,
    provenance,
    trustPolicyVersion,
    details: {
      action: 'supersede',
      supersededByMemoryId: newMemoryId,
      previousStatus: oldPreviousStatus,
      newStatus: 'superseded',
    },
  };
  // PR-S5
  oldMemoryUpdateEvent.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

  const eventValidation = validateMemoryEvent(event);
  if (!eventValidation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'event validation failed', details: eventValidation.errors } };
  }

  const oldEventValidation = validateMemoryEvent(oldMemoryUpdateEvent);
  if (!oldEventValidation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'old memory update event validation failed', details: oldEventValidation.errors } };
  }

  // Storage layer (SQLite present): transactional, rollback on error.
  const persistResult = storeApi.persist(opts, {
    newRecord,
    oldRecord,
    link,
    event,
    oldMemoryUpdateEvent,
    getContentHash,
  });
  if (persistResult && persistResult.ok === false) {
    return persistResult;
  }

  // Freeze content and update in-memory cache
  Object.freeze(newRecord.content);
  storeApi.remember(newRecord, storeApi.makeKey(workspaceId, newMemoryId));

  oldRecord.status = 'superseded';
  oldRecord.updatedAt = now;

  storeApi.appendLinks(link);
  storeApi.appendEvents(event, oldMemoryUpdateEvent);

  return {
    ok: true,
    oldMemory: cloneMemoryRecord(oldRecord),
    newMemory: cloneMemoryRecord(newRecord),
    link: cloneMemoryLink(link),
    event: cloneMemoryEvent(event),
    oldMemoryUpdateEvent: cloneMemoryEvent(oldMemoryUpdateEvent),
  };
}

module.exports = { runSupersede };
