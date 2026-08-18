'use strict';

// Delegated from lib/memory-store.js (MemoryStore.query / search) by #328 MS.
// The class method is now a one-line delegation:
//   return runQuery({ memories: this._memories, isActiveRecord: this._isActiveRecord.bind(this) }, opts);
//
// Context interface (documented, docs-first):
//   memories     - Map (workspaceId:memoryId -> record); iterated read-only
//   isActiveRecord(record) - active-status predicate owned by the store
// Neither parameter may be mutated by this module. All decisions are pure
// transforms of the input opts; validation failures return fail-closed
// { ok: false, error } payloads identical to the original method.
const {
  toStableString,
  isValidIsoDate,
  normalizeWorkspaceId,
} = require('./memory-store-utils');
const { cloneMemoryRecord } = require('./memory-record-utils');

function normalizePagination(opts = {}) {
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

function validateDateFilters(opts = {}) {
  const dateFilters = ['createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore'];
  for (const df of dateFilters) {
    if (opts[df] !== undefined && opts[df] !== null) {
      if (!isValidIsoDate(opts[df])) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid date format for ${df}` } };
      }
    }
  }
  return { ok: true };
}

function validateOrdering(opts = {}) {
  const orderBy = opts.orderBy || 'createdAt';
  const order = opts.order || 'asc';
  if (!['createdAt', 'updatedAt', 'memoryId'].includes(orderBy)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid orderBy option: ${orderBy}` } };
  }
  if (!['asc', 'desc'].includes(order)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid order option: ${order}` } };
  }
  return { ok: true, orderBy, order };
}

function parseDateFilter(opts, key) {
  return opts[key] ? new Date(opts[key]).getTime() : null;
}

function recordPassesFilter(record, filters) {
  // 1. Workspace boundary (strictly enforced)
  if (record.workspaceId !== filters.workspaceId) return false;
  // 2. Non-active status (only when no explicit status filter)
  if (!filters.includeDeleted && filters.status === undefined && !filters.isActiveRecord(record)) return false;
  // 3. Kind
  const recordKind = record.kind || 'memory-record';
  if (filters.kind !== undefined && recordKind !== filters.kind) return false;
  // 4. Status
  if (filters.status !== undefined && record.status !== filters.status) return false;
  // 5. Actor
  if (filters.actor !== undefined && record.provenance?.actor !== filters.actor) return false;
  // 6. SourceType
  if (filters.sourceType !== undefined && record.provenance?.sourceType !== filters.sourceType) return false;
  // 7. SourceRef
  if (filters.sourceRef !== undefined && record.provenance?.sourceRef !== filters.sourceRef) return false;
  // 8. Date ranges (inclusive)
  if (record.createdAt) {
    const cat = new Date(record.createdAt).getTime();
    if (filters.createdAfter !== null && cat < filters.createdAfter) return false;
    if (filters.createdBefore !== null && cat > filters.createdBefore) return false;
  }
  if (record.updatedAt) {
    const uat = new Date(record.updatedAt).getTime();
    if (filters.updatedAfter !== null && uat < filters.updatedAfter) return false;
    if (filters.updatedBefore !== null && uat > filters.updatedBefore) return false;
  } else {
    if (filters.updatedAfter !== null || filters.updatedBefore !== null) return false;
  }
  // 9. Content search
  if (filters.contentIncludesLower !== null) {
    const contentStr = toStableString(record.content).toLowerCase();
    if (!contentStr.includes(filters.contentIncludesLower)) return false;
  }
  // 10. Metadata exact match (shallow)
  if (filters.metadataFilter) {
    const recMeta = record.metadata || {};
    for (const [k, v] of Object.entries(filters.metadataFilter)) {
      if (recMeta[k] !== v) return false;
    }
  }
  return true;
}

function sortRecords(results, orderBy, order) {
  results.sort((a, b) => {
    let valA = a[orderBy];
    let valB = b[orderBy];
    if (valA === undefined || valA === null) valA = '';
    if (valB === undefined || valB === null) valB = '';
    let comp = 0;
    if (orderBy === 'createdAt' || orderBy === 'updatedAt') {
      comp = valA.localeCompare(valB);
    } else {
      comp = String(valA).localeCompare(String(valB));
    }
    if (comp !== 0) {
      return order === 'asc' ? comp : -comp;
    }
    // Tie-breaker: memoryId asc
    return a.memoryId.localeCompare(b.memoryId);
  });
}

/**
 * Run a filtered/sorted/paginated query over the store's in-memory records.
 * @param {object} context - { memories: Map, isActiveRecord: (record) => boolean }
 * @param {object} opts - query options (same shape as MemoryStore.query)
 * @returns {{ ok: boolean, memories?: object[], total?: number, limit?: (number|null), offset?: number, error?: object }}
 */
function runQuery(context, opts = {}) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'options must be an object' } };
  }
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);

  const pagination = normalizePagination(opts);
  if (!pagination.ok) return pagination;
  const { offset, limit } = pagination;

  const dateValidation = validateDateFilters(opts);
  if (!dateValidation.ok) return dateValidation;

  // Metadata filter - shallow match
  const metadataFilter = opts.metadata;
  if (metadataFilter && (typeof metadataFilter !== 'object' || Array.isArray(metadataFilter))) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'metadata filter must be an object' } };
  }

  const ordering = validateOrdering(opts);
  if (!ordering.ok) return ordering;
  const { orderBy, order } = ordering;

  const contentIncludes = opts.contentIncludes || opts.text;
  const contentIncludesLower = contentIncludes ? String(contentIncludes).toLowerCase() : null;

  const filters = {
    workspaceId,
    includeDeleted: opts.includeDeleted === true || opts.includeTombstoned === true,
    status: opts.status,
    kind: opts.kind,
    actor: opts.actor,
    sourceType: opts.sourceType,
    sourceRef: opts.sourceRef,
    createdAfter: parseDateFilter(opts, 'createdAfter'),
    createdBefore: parseDateFilter(opts, 'createdBefore'),
    updatedAfter: parseDateFilter(opts, 'updatedAfter'),
    updatedBefore: parseDateFilter(opts, 'updatedBefore'),
    contentIncludesLower,
    metadataFilter,
    isActiveRecord: context.isActiveRecord,
  };

  const results = [];
  for (const record of context.memories.values()) {
    if (recordPassesFilter(record, filters)) results.push(record);
  }

  sortRecords(results, orderBy, order);
  const total = results.length;
  const page = results.slice(offset, offset + limit);
  return {
    ok: true,
    memories: page.map(cloneMemoryRecord),
    total,
    limit: limit === Infinity ? null : limit,
    offset,
  };
}

module.exports = { runQuery };
