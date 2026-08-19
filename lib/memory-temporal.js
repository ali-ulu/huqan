'use strict';

// Delegated from lib/memory-store.js (MemoryStore._queryTemporalMemories,
// since, before and between) by #328 MS. This module owns only the temporal
// read projection. It receives the store-owned memory Map as read-only input;
// it has no receiver, persistence handle, transaction, or mutation callback.
const { normalizeWorkspaceId } = require('./memory-store-utils');
const {
  sortByCreatedAtThenId,
  cloneMemoryRecord,
  parseTemporalBoundary,
  readTemporalField,
  matchesTemporalRange,
} = require('./memory-record-utils');

/**
 * @typedef {object} TemporalReadContext
 * @property {Map} memories - MemoryStore cache, iterated without mutation.
 */

/**
 * Run a temporal memory query with the exact validation and ordering contract
 * previously owned by MemoryStore._queryTemporalMemories.
 *
 * @param {TemporalReadContext} context
 * @param {object} opts
 * @returns {{ok:boolean,memories?:object[],total?:number,workspaceId?:string,field?:string,range?:object,error?:object}}
 */
function runTemporalQuery(context, opts = {}) {
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const field = typeof opts.field === 'string' && opts.field.trim() ? opts.field.trim() : 'createdAt';
  const allowedFields = ['createdAt', 'updatedAt', 'deletedAt', 'accessedAt'];
  if (!allowedFields.includes(field)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'field must be createdAt, updatedAt, deletedAt, or accessedAt' } };
  }

  const includeTombstoned = opts.includeTombstoned === true;
  const range = {
    since: parseTemporalBoundary(opts.since),
    after: parseTemporalBoundary(opts.after),
    before: parseTemporalBoundary(opts.before),
    until: parseTemporalBoundary(opts.until),
    start: Array.isArray(opts.between) ? parseTemporalBoundary(opts.between[0]) : parseTemporalBoundary(opts.start),
    end: Array.isArray(opts.between) ? parseTemporalBoundary(opts.between[1]) : parseTemporalBoundary(opts.end),
  };

  const memories = [];
  for (const record of context.memories.values()) {
    if (record.workspaceId !== workspaceId) continue;
    if (!includeTombstoned && record.status === 'deleted') continue;
    const value = readTemporalField(record, field);
    if (!matchesTemporalRange(value, range)) continue;
    memories.push(record);
  }

  memories.sort((left, right) => sortByCreatedAtThenId(left, right, 'memoryId'));
  return {
    ok: true,
    memories: memories.map(cloneMemoryRecord),
    total: memories.length,
    workspaceId,
    field,
    range,
  };
}

module.exports = { runTemporalQuery };
