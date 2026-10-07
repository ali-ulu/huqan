'use strict';

// Delegated from lib/memory-store.js (MemoryStore.query / search) by #328 MS.
// The class method is now a one-line delegation:
//   return runQuery({ memories: this._memories }, opts);
//
// Context interface (documented, docs-first):
//   memories     - Map (workspaceId:memoryId -> record); iterated read-only
//   readPage(filters) - optional indexed SQLite page reader
// Default-read visibility comes from memory-record-visibility.js (#3493).
// Neither parameter may be mutated by this module. All decisions are pure
// transforms of the input opts; validation failures return fail-closed
// { ok: false, error } payloads identical to the original method.
const {
  toStableString,
  isValidIsoDate,
  normalizeWorkspaceId,
} = require('./memory-store-utils');
const { cloneMemoryRecord } = require('./memory-record-utils');
const { isHiddenByDefault } = require('./memory-record-visibility');
const { evaluateMemoryRecall } = require('./memory-recall-gate');
const { rankByBm25 } = require('./memory-query-bm25');
const { normalizeRecencyOptions, rankByRecency } = require('./memory-recency-decay');

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

// Opt-in relevance ranking (lib/memory-query-bm25.js). Absent `retrievalMode` the
// substring path and the response shape are exactly what callers always got.
// BM25 orders by relevance, so an explicit orderBy/order would be silently
// ignored -- it is refused instead, as is `explain` without BM25.
function validateRetrievalMode(opts, contentIncludes) {
  const mode = opts.retrievalMode === undefined ? 'substring' : opts.retrievalMode;
  if (!['substring', 'bm25', 'recency'].includes(mode)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid retrievalMode option: ${mode}` } };
  }
  if (opts.explain !== undefined && (mode !== 'bm25' || typeof opts.explain !== 'boolean')) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'explain must be a boolean and requires retrievalMode bm25' } };
  }
  if (mode === 'bm25' && !contentIncludes) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'retrievalMode bm25 requires text' } };
  }
  if ((mode === 'bm25' || mode === 'recency') && (opts.orderBy !== undefined || opts.order !== undefined)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `retrievalMode ${mode} orders by rank; omit orderBy and order` } };
  }
  // `recency` is the only mode that takes a `recency` object; passing one to
  // another mode is a silent no-op otherwise, refused instead.
  if (opts.recency !== undefined && mode !== 'recency') {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'recency options require retrievalMode recency' } };
  }
  return { ok: true, mode };
}

function retrievalSummary(page, ranked, explain) {
  const byId = new Map(ranked.map((hit) => [hit.record.memoryId, hit]));
  return {
    mode: 'bm25',
    scores: page.map((record) => {
      const hit = byId.get(record.memoryId);
      return explain ? { memoryId: record.memoryId, score: hit.score, terms: hit.terms }
        : { memoryId: record.memoryId, score: hit.score };
    }),
  };
}

function parseDateFilter(opts, key) {
  return opts[key] ? new Date(opts[key]).getTime() : null;
}

// The recency response mirrors the BM25 one: the caller sees the mode, the
// resolved reference instant and each record's factor, so a ranking decision
// can be audited instead of guessed.
function recencySummary(page, ranked, resolved) {
  const byId = new Map(ranked.map((hit) => [hit.record.memoryId, hit]));
  return {
    mode: 'recency',
    halfLifeDays: resolved.halfLifeDays,
    asOf: new Date(resolved.asOf).toISOString(),
    scores: page.map((record) => ({ memoryId: record.memoryId, recency: byId.get(record.memoryId).recency })),
  };
}

function recordPassesFilter(record, filters) {
  // 1. Workspace boundary (strictly enforced)
  if (record.workspaceId !== filters.workspaceId) return false;
  // 2. Hidden statuses (deleted/archived), only when no explicit status filter.
  // `includeDeleted`/`includeTombstoned` reveal every hidden status;
  // `includeArchived` reveals archived only, so deleted stays hidden unless
  // asked for. #3493: before archive had a writer, `isActiveRecord` was the
  // whole story; the archived status now has to be excluded here too.
  if (filters.status === undefined && isHiddenByDefault(record, filters)) return false;
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
 * @param {object} context - { memories: Map, readPage?: Function }
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
  const retrieval = validateRetrievalMode(opts, contentIncludes);
  if (!retrieval.ok) return retrieval;
  const isBm25 = retrieval.mode === 'bm25';
  const isRecency = retrieval.mode === 'recency';
  // BM25 scores the text instead of requiring it as a substring.
  const contentIncludesLower = contentIncludes && !isBm25 ? String(contentIncludes).toLowerCase() : null;
  // Recency resolves one reference instant up front; a malformed option is a
  // fail-closed refusal, not a silent fallback to the substring path.
  let resolvedRecency = null;
  if (isRecency) {
    const recencyOptions = normalizeRecencyOptions(opts.recency === undefined ? {} : opts.recency);
    if (!recencyOptions.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: recencyOptions.message } };
    }
    resolvedRecency = recencyOptions;
  }

  const filters = {
    workspaceId,
    includeDeleted: opts.includeDeleted === true || opts.includeTombstoned === true,
    includeArchived: opts.includeArchived === true,
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
  };

  if (context.readPage) {
    const indexedPage = context.readPage({ opts, workspaceId, offset, limit, orderBy, order });
    if (indexedPage) return indexedPage;
  }

  let results = [];
  for (const record of context.memories.values()) {
    if (recordPassesFilter(record, filters)) results.push(record);
  }

  // Opt-in read-side trust gate (lib/memory-recall-gate.js). Absent
  // `opts.recall` this is inert and the returned shape is identical to what
  // callers have always received. It runs before sort and pagination on
  // purpose: a record the gate will withhold must not occupy a slot on a page.
  let recall = null;
  if (opts.recall) {
    const recallOpts = opts.recall === true ? {} : opts.recall;
    if (typeof recallOpts !== 'object' || Array.isArray(recallOpts)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'recall must be an object or true' } };
    }
    const verdict = evaluateMemoryRecall({ ...recallOpts, workspaceId, records: results });
    if (!verdict.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: verdict.errors[0].message } };
    }
    // #2795: keep `degrade` records in the page, drop only `withhold`.
    // lib/memory-recall-gate.js's own contract is explicit -- "degrade is not
    // false": a degraded record may be perfectly accurate, just no longer
    // provably authoritative, and the caller is expected to consult
    // `response.recall.decisions` (or `.degraded`) to see which. Dropping it
    // from `memories` entirely (the prior behaviour, `results =
    // verdict.admitted`) silently contradicted that contract -- a degraded
    // record never reached the caller at all, indistinguishable from a
    // withheld one. Only `withhold` -- unprovenanced, inactive, cross-
    // workspace, or malformed -- has no business reaching a context window.
    const withheldIds = new Set(verdict.withheld.map((entry) => entry.memoryId));
    results = results.filter((record) => !withheldIds.has(record.memoryId));
    recall = verdict;
  }

  let ranked = null;
  let recency = null;
  if (isBm25) {
    ranked = rankByBm25(results, String(contentIncludes));
    results = ranked.map((hit) => hit.record);
  } else if (isRecency) {
    // Default-off recency ranking (#3492, R37). The factor is read-only; it
    // orders the already-filtered set and never mutates a record.
    recency = rankByRecency(results, resolvedRecency);
    results = recency.map((hit) => hit.record);
  } else {
    sortRecords(results, orderBy, order);
  }
  const total = results.length;
  const page = results.slice(offset, offset + limit);
  const response = {
    ok: true,
    memories: page.map(cloneMemoryRecord),
    total,
    limit: limit === Infinity ? null : limit,
    offset,
  };
  if (recall) response.recall = recall;
  if (ranked) response.retrieval = retrievalSummary(page, ranked, opts.explain === true);
  if (recency) response.recency = recencySummary(page, recency, resolvedRecency);
  return response;
}

/**
 * Memories created between two ISO timestamps. Moved verbatim from
 * MemoryStore.memoriesBetween by #2129: validate the range, then run the
 * same query the store would run. Takes the runQuery context directly so
 * the store method stays a thin delegation.
 * @param {object} context - runQuery context ({ memories })
 * @param {string} start - ISO start timestamp
 * @param {string} end - ISO end timestamp
 * @param {object} opts
 */
function runMemoriesBetween(context, start, end, opts = {}) {
  if (!start || !end) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'start and end dates are required' } };
  }
  if (!isValidIsoDate(start)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for start date' } };
  }
  if (!isValidIsoDate(end)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for end date' } };
  }

  const queryOpts = {
    ...opts,
    createdAfter: start,
    createdBefore: end,
  };
  return runQuery(context, queryOpts);
}

module.exports = { runQuery, runMemoriesBetween };
