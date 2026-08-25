'use strict';

const { normalizeWorkspaceId, getContentHash } = require('./memory-store-utils');
const {
  sortByCreatedAtThenId,
  cloneMemoryRecord,
} = require('./memory-record-utils');

/**
 * Record-read context supplied by MemoryStore.
 *
 * @typedef {object} RecordReadContext
 * @property {Map<string, object>} memories - Store-owned records; never mutated here.
 * @property {Function} findMemory - (memoryId, workspaceId) => memory record | undefined
 * @property {Function} isActiveRecord - record => boolean
 */

/**
 * List workspace-scoped memories with the original deterministic ordering and pagination.
 * Context-owned records are read-only; filtering decisions and cloning remain here.
 */
function listMemories(context, opts = {}) {
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const includeTombstoned = opts.includeTombstoned === true;
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : Infinity;
  const offset = typeof opts.offset === 'number' && opts.offset >= 0 ? opts.offset : 0;
  // Filtering by content kind happens here rather than in the caller, because
  // the caller only ever sees records that have already been deep-copied.
  // ErrorPreventionStore.listKind() listed the whole workspace and filtered
  // afterwards, so preflight paid a full clone of every record in the
  // workspace to find rules -- linear in workspace size even when there were
  // no rules at all (#1541).
  const contentKind = typeof opts.contentKind === 'string' && opts.contentKind ? opts.contentKind : null;

  let memories = [];
  for (const record of context.memories.values()) {
    if (record.workspaceId !== workspaceId) continue;
    if (!includeTombstoned && !context.isActiveRecord(record)) continue;
    if (contentKind !== null && record?.content?.kind !== contentKind) continue;
    memories.push(record);
  }

  memories.sort(sortByCreatedAtThenId);
  const total = memories.length;
  memories = memories.slice(offset, offset + limit);

  return { ok: true, memories: memories.map(cloneMemoryRecord), total };
}

function getMemory(context, memoryId, opts = {}) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }

  const wid = normalizeWorkspaceId(opts.workspaceId);
  const record = context.findMemory(memoryId, wid);
  if (!record) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
  }

  if (wid && record.workspaceId !== wid) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
  }

  return { ok: true, memory: cloneMemoryRecord(record) };
}

function findById(context, memoryId, opts = {}) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }

  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const record = context.findMemory(memoryId, workspaceId);
  if (!record || record.workspaceId !== workspaceId) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${workspaceId}` } };
  }
  if (!opts.includeTombstoned && record.status === 'deleted') {
    return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${workspaceId}` } };
  }

  return { ok: true, memory: cloneMemoryRecord(record) };
}

function findByContentHash(context, contentHash, opts = {}) {
  const needle = typeof contentHash === 'string' ? contentHash.trim() : '';
  if (!needle) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'contentHash is required' } };
  }
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const includeTombstoned = opts.includeTombstoned === true;
  const memories = [];
  for (const record of context.memories.values()) {
    if (record.workspaceId !== workspaceId) continue;
    if (!includeTombstoned && !context.isActiveRecord(record)) continue;
    if (getContentHash(record.content) !== needle) continue;
    memories.push(record);
  }
  memories.sort(sortByCreatedAtThenId);
  return { ok: true, memories: memories.map(cloneMemoryRecord), total: memories.length, contentHash: needle };
}

function findBySourceRef(context, sourceRef, opts = {}) {
  const needle = typeof sourceRef === 'string' ? sourceRef.trim() : '';
  if (!needle) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'sourceRef is required' } };
  }
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const includeTombstoned = opts.includeTombstoned === true;
  const memories = [];
  for (const record of context.memories.values()) {
    if (record.workspaceId !== workspaceId) continue;
    if (!includeTombstoned && !context.isActiveRecord(record)) continue;
    if (record.provenance?.sourceRef !== needle) continue;
    memories.push(record);
  }
  memories.sort(sortByCreatedAtThenId);
  return { ok: true, memories: memories.map(cloneMemoryRecord), total: memories.length, sourceRef: needle };
}

function findByKind(context, kind, opts = {}) {
  const needle = typeof kind === 'string' ? kind.trim() : '';
  if (!needle) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'kind is required' } };
  }
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const includeTombstoned = opts.includeTombstoned === true;
  const memories = [];
  for (const record of context.memories.values()) {
    if (record.workspaceId !== workspaceId) continue;
    if (!includeTombstoned && !context.isActiveRecord(record)) continue;
    if ((record.kind || 'memory-record') !== needle) continue;
    memories.push(record);
  }
  memories.sort(sortByCreatedAtThenId);
  return { ok: true, memories: memories.map(cloneMemoryRecord), total: memories.length, kind: needle };
}

function findByStatus(context, status, opts = {}) {
  const needle = typeof status === 'string' ? status.trim() : '';
  if (!needle) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'status is required' } };
  }
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const memories = [];
  for (const record of context.memories.values()) {
    if (record.workspaceId !== workspaceId) continue;
    if (record.status !== needle) continue;
    memories.push(record);
  }
  memories.sort(sortByCreatedAtThenId);
  return { ok: true, memories: memories.map(cloneMemoryRecord), total: memories.length, status: needle };
}

module.exports = {
  listMemories,
  getMemory,
  findById,
  findByContentHash,
  findBySourceRef,
  findByKind,
  findByStatus,
};
