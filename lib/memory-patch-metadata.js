'use strict';

// Delegated from lib/memory-store.js (MemoryStore.patchMetadata) by #328 MS.
// This module owns input normalization, metadata patching, event construction,
// and validation. Persistence and store-owned mutation remain behind the API.
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
 * Store API required by runPatchMetadata.
 *
 * @typedef {object} PatchMetadataStoreApi
 * @property {Function} findMemory - (memoryId, workspaceId) => record | undefined
 * @property {Function} persist - (opts, payload) => undefined | {ok:false,error:object}
 * @property {Function} applyPatch - (record, nextMetadata, now) => undefined
 * @property {Function} appendEvent - event => undefined
 */

/**
 * Patch mutable metadata only. Content and status are immutable here.
 *
 * @param {PatchMetadataStoreApi} storeApi
 * @param {string} memoryId
 * @param {object} patch - key/value pairs to merge into metadata
 * @param {object} opts - { actor?, workspaceId? }
 * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
 */
function runPatchMetadata(storeApi, memoryId, patch = {}, opts = {}) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'patch must be a plain object' } };
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: { code: 'EMPTY_PATCH', message: 'patch must contain at least one key' } };
  }

  // Guard: cannot overwrite content via metadata patch
  if ('content' in patch) {
    return { ok: false, error: { code: 'IMMUTABLE_CONTENT', message: 'content cannot be changed via patchMetadata; use supersede instead' } };
  }

  // Guard: cannot overwrite status via metadata patch
  if ('status' in patch) {
    return { ok: false, error: { code: 'IMMUTABLE_STATUS', message: 'status cannot be changed via patchMetadata; use tombstone/supersede instead' } };
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
  const safePatch = JSON.parse(JSON.stringify(patch));
  const nextMetadata = { ...(record.metadata || {}) };
  for (const key of Object.keys(safePatch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    nextMetadata[key] = safePatch[key];
  }

  const event = {
    eventId: generateEventId(),
    eventType: 'UPDATED',
    memoryId,
    workspaceId: record.workspaceId,
    createdAt: now,
    actor,
    provenance,
    trustPolicyVersion,
    details: { action: 'patchMetadata', patch },
  };
  // PR-S5
  event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;
  const eventValidation = validateMemoryEvent(event);
  if (!eventValidation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'event validation failed', details: eventValidation.errors } };
  }

  const persistResult = storeApi.persist(opts, { record, event, nextMetadata, now });
  if (persistResult && persistResult.ok === false) {
    return persistResult;
  }

  storeApi.applyPatch(record, nextMetadata, now);
  storeApi.appendEvent(event);

  return { ok: true, memory: cloneMemoryRecord(record), event: cloneMemoryEvent(event) };
}

module.exports = { runPatchMetadata };
