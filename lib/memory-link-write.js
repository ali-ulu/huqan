'use strict';

// Delegated from lib/memory-store.js (MemoryStore.linkMemories) by #328 MS.
// The delegate owns payload construction and validation, while the store API
// owns storage state, SQLite transactions, rollback, and post-validation appends.
// All write-capable API calls occur only after every validation decision succeeds.
const {
  validateMemoryEvent,
  validateMemoryLink,
  MEMORY_SCHEMA_VERSIONS,
} = require('./memory-schema');
const {
  makeProvenance,
  generateDeterministicLinkId,
  generateEventId,
  normalizeWorkspaceId,
} = require('./memory-store-utils');
const { cloneMemoryLink, cloneMemoryEvent } = require('./memory-record-utils');

const VALID_RELATIONS = ['supersedes', 'contradicts', 'supports', 'references', 'related_to'];

/**
 * Store API required by runLinkMemories.
 *
 * @typedef {object} LinkWriteStoreApi
 * @property {Function} findMemory - (memoryId, workspaceId) => record | undefined
 * @property {Function} findLink - (linkId, workspaceId) => link | undefined
 * @property {string} defaultTrustPolicyVersion
 * @property {Function} persist - (opts, payload) => undefined | {ok:false,error:object}
 * @property {Function} appendLink - link => undefined
 * @property {Function} appendEvent - event => undefined
 */

/**
 * Create an idempotent link and its LINKED event.
 *
 * @param {LinkWriteStoreApi} storeApi
 * @param {object} opts
 * @returns {{ok:boolean,link?:object,event?:object,error?:object}}
 */
function runLinkMemories(storeApi, opts = {}) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'options must be an object' } };
  }
  const fromMemoryId = String(opts.fromMemoryId || '').trim();
  const toMemoryId = String(opts.toMemoryId || '').trim();
  const relation = String(opts.relation || '').trim();
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);

  if (!fromMemoryId || !toMemoryId || !relation) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'fromMemoryId, toMemoryId and relation are required' } };
  }

  // A memory cannot stand in a relation to itself: a self-supersedes or
  // self-contradicts edge is degenerate and would pollute causal traversal,
  // where the root reappears among its own linked memories.
  if (fromMemoryId === toMemoryId) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'cannot link a memory to itself' } };
  }

  const fromMemory = storeApi.findMemory(fromMemoryId, workspaceId);
  const toMemory = storeApi.findMemory(toMemoryId, workspaceId);

  if (!fromMemory || fromMemory.workspaceId !== workspaceId) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `source memory ${fromMemoryId} not found in workspace ${workspaceId}` } };
  }
  if (!toMemory || toMemory.workspaceId !== workspaceId) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `target memory ${toMemoryId} not found in workspace ${workspaceId}` } };
  }

  if (fromMemory.status === 'deleted' || toMemory.status === 'deleted') {
    return { ok: false, error: { code: 'INVALID_STATE', message: 'cannot link deleted or tombstoned memories' } };
  }

  if (!VALID_RELATIONS.includes(relation)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid relation: ${relation}` } };
  }

  const linkId = generateDeterministicLinkId(workspaceId, fromMemoryId, toMemoryId, relation);
  const existingLink = storeApi.findLink(linkId, workspaceId);
  if (existingLink) {
    return { ok: true, link: cloneMemoryLink(existingLink) };
  }

  const now = new Date().toISOString();
  const trustPolicyVersion = opts.trustPolicyVersion || storeApi.defaultTrustPolicyVersion;
  const actor = opts.actor || 'system';
  const provenance = opts.provenance || makeProvenance(actor, workspaceId, trustPolicyVersion);

  const link = {
    linkId,
    relation,
    fromMemoryId,
    toMemoryId,
    workspaceId,
    createdAt: now,
    provenance,
    trustPolicyVersion,
    strength: opts.confidence !== undefined ? Number(opts.confidence) : 1.0,
    metadata: opts.metadata || {},
  };
  // PR-S5
  link.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryLink;

  const validation = validateMemoryLink(link);
  if (!validation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'link validation failed', details: validation.errors } };
  }

  const event = {
    eventId: generateEventId(),
    eventType: 'LINKED',
    memoryId: fromMemoryId,
    workspaceId,
    createdAt: now,
    actor,
    provenance,
    trustPolicyVersion,
    details: { action: 'linkMemories', relation, toMemoryId, linkId },
  };
  // PR-S5
  event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

  const eventValidation = validateMemoryEvent(event);
  if (!eventValidation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'linked event validation failed', details: eventValidation.errors } };
  }

  const persistResult = storeApi.persist(opts, { link, event });
  if (persistResult && persistResult.ok === false) {
    return persistResult;
  }

  storeApi.appendLink(link);
  storeApi.appendEvent(event);

  return { ok: true, link: cloneMemoryLink(link), event: cloneMemoryEvent(event) };
}

module.exports = { runLinkMemories };
