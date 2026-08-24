'use strict';

// Delegated from lib/memory-store.js (MemoryStore.eventsForMemory and
// MemoryStore.timeline) by #328 MS. The delegate is intentionally read-only:
// it receives event data and the one lookup needed for eventsForMemory, but
// never receives a store receiver, SQLite state, or mutation functions.
const { isValidIsoDate, normalizeWorkspaceId } = require('./memory-store-utils');
const { cloneMemoryEvent, sortByEventSignature } = require('./memory-record-utils');

/**
 * @typedef {object} EventReadContext
 * @property {object[]} events - append-only event records, read-only here
 * @property {Function} findMemory - (memoryId, workspaceId) => record | undefined
 */

function parsePagination(opts) {
  let offset = 0;
  if (opts.offset !== undefined) {
    offset = Number(opts.offset);
    if (isNaN(offset) || offset < 0) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'offset must be a non-negative number' } };
    }
  }

  let limit = 100;
  if (opts.limit !== undefined) {
    if (opts.limit === null) {
      limit = Infinity;
    } else {
      limit = Number(opts.limit);
      if (isNaN(limit) || limit < 0) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit must be a non-negative number or null' } };
      }
      if (limit > 1000) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit exceeds max limit of 1000' } };
      }
    }
  }
  return { ok: true, offset, limit };
}

function validateDateRange(opts) {
  if (opts.createdAfter && !isValidIsoDate(opts.createdAfter)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for createdAfter' } };
  }
  if (opts.createdBefore && !isValidIsoDate(opts.createdBefore)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for createdBefore' } };
  }
  return { ok: true };
}

function finishEvents(events, offset, limit) {
  events.sort(sortByEventSignature);
  const total = events.length;
  const page = events.slice(offset, offset + limit);
  return {
    events: page.map(cloneMemoryEvent),
    total,
    limit: limit === Infinity ? null : limit,
    offset,
  };
}

/**
 * Get all events for a memory within the normalized workspace.
 * @param {EventReadContext} context
 * @param {string} memoryId
 * @param {object} opts
 * @returns {object[]}
 */
function runGetEvents(context, memoryId, opts = {}) {
  if (!memoryId) return [];
  const id = memoryId.trim();
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  return context.events
    .filter(event => event.memoryId === id && event.workspaceId === workspaceId)
    .sort(sortByEventSignature)
    .map(cloneMemoryEvent);
}

/**
 * Get events for one memory.
 * @param {EventReadContext} context
 * @param {string} memoryId
 * @param {object} opts
 * @returns {{ok:boolean,events?:object[],total?:number,limit?:number|null,offset?:number,error?:object}}
 */
function runEventsForMemory(context, memoryId, opts = {}) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }
  const id = memoryId.trim();
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);

  const record = context.findMemory(id, workspaceId);
  if (!record || record.workspaceId !== workspaceId) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${id} not found in workspace ${workspaceId}` } };
  }

  const eventType = opts.eventType;
  const createdAfter = opts.createdAfter ? new Date(opts.createdAfter).getTime() : null;
  const createdBefore = opts.createdBefore ? new Date(opts.createdBefore).getTime() : null;
  const dateValidation = validateDateRange(opts);
  if (!dateValidation.ok) return dateValidation;

  const pagination = parsePagination(opts);
  if (!pagination.ok) return pagination;

  const results = [];
  for (const event of context.events) {
    if (event.workspaceId !== workspaceId) continue;
    if (event.memoryId !== id) continue;
    if (eventType && event.eventType !== eventType) continue;

    const timestamp = new Date(event.createdAt).getTime();
    if (createdAfter !== null && timestamp < createdAfter) continue;
    if (createdBefore !== null && timestamp > createdBefore) continue;
    results.push(event);
  }

  return { ok: true, ...finishEvents(results, pagination.offset, pagination.limit) };
}

/**
 * Get a workspace-wide event timeline.
 * @param {EventReadContext} context
 * @param {object} opts
 * @returns {{ok:boolean,events?:object[],total?:number,limit?:number|null,offset?:number,error?:object}}
 */
function runTimeline(context, opts = {}) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'options must be an object' } };
  }

  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const actor = opts.actor;
  const eventType = opts.eventType;
  const createdAfter = opts.createdAfter ? new Date(opts.createdAfter).getTime() : null;
  const createdBefore = opts.createdBefore ? new Date(opts.createdBefore).getTime() : null;
  const dateValidation = validateDateRange(opts);
  if (!dateValidation.ok) return dateValidation;

  const pagination = parsePagination(opts);
  if (!pagination.ok) return pagination;

  const results = [];
  for (const event of context.events) {
    if (event.workspaceId !== workspaceId) continue;
    if (actor && event.actor !== actor) continue;
    if (eventType && event.eventType !== eventType) continue;

    const timestamp = new Date(event.createdAt).getTime();
    if (createdAfter !== null && timestamp < createdAfter) continue;
    if (createdBefore !== null && timestamp > createdBefore) continue;
    results.push(event);
  }

  return { ok: true, ...finishEvents(results, pagination.offset, pagination.limit) };
}

module.exports = { runEventsForMemory, runTimeline, runGetEvents };
