'use strict';

/**
 * Audit-log read primitives (issues #728, #729).
 *
 * The audit log is the one table that grows without bound during normal
 * operation, so every read of it has to say how much it is willing to read.
 * Three primitives live here:
 *
 *   readAuditEvents()  - the historical materializing read, unchanged
 *   countAuditEvents() - COUNT(*), one row out regardless of table size
 *   queryAuditEvents() - filter-pushed-down keyset page, at most `limit` rows
 *
 * Reading the whole table to answer "how many?" (#728) or "give me the events
 * for this one target" (#729) made both an O(total audit history) operation in
 * CPU and memory, which is a resource-exhaustion lever rather than a
 * performance nit: the cost is controlled by history size, not request size.
 *
 * These take an explicit context rather than a Graph so the SQL stays testable
 * on its own and so graph.js — which is at its line-count ceiling — keeps only
 * thin delegates.
 *
 * This module is the reader: the SQL, the statement cache, and the choice
 * between the table and the in-memory mirror. The caller-facing half of the
 * same surface — limit clamping, cursors, filter construction, comparison and
 * the row -> event mapping — is pure, carries no context and lives in
 * ./audit-query-primitives.js (#2270). Both halves are re-exported here so
 * callers keep one entry point.
 *
 * Not to be confused with lib/audit-bounded-read.js, which solves a different
 * problem: it streams a whole workspace one row at a time with a per-event
 * details byte cap and a durable/in-memory divergence check, for receipt bundle
 * export. It deliberately has no predicate pushdown and no page limit, so it
 * cannot answer "the events for this one target, at most N of them" cheaply.
 * That is what queryAuditEvents() below is for.
 *
 * @typedef {object} AuditQueryContext
 * @property {object|null} db             better-sqlite3 handle, or null
 * @property {object|null} stmts          prepared statements owned by the graph
 * @property {Array}       events         the in-memory audit mirror
 * @property {Map}         statementCache prepared statements keyed by SQL
 */

const { getAuditEvents: filterAuditEvents } = require('./audit-log');
const { cloneAuditEvent } = require('./graph-record-utils');
const {
  AUDIT_FILTER_COLUMNS,
  AUDIT_QUERY_DEFAULT_LIMIT,
  AUDIT_QUERY_MAX_LIMIT,
  buildAuditFilter,
  clampAuditLimit,
  compareEvents,
  decodeAuditCursor,
  encodeAuditCursor,
  rowToEvent,
} = require('./audit-query-primitives');

/**
 * Sort key for a page. `targetId` is in the middle because recordSort() in
 * provenance-query.js already ties on it; `auditId` is appended so equal
 * (timestamp, targetId) pairs still have one defined order, which is what
 * makes keyset pagination safe.
 */
const ORDER_COLUMNS = "timestamp, COALESCE(target_id, ''), audit_id";

function prepare(ctx, sql) {
  let statement = ctx.statementCache.get(sql);
  if (!statement) {
    statement = ctx.db.prepare(sql);
    ctx.statementCache.set(sql, statement);
  }
  return statement;
}

/**
 * True when the table is authoritative for counting.
 *
 * appendAuditEvent() write-throughs to audit_log on every append, so the table
 * is normally a superset of the in-memory mirror. The one arrangement where it
 * is not — events buffered before a database was attached — shows up as a
 * mirror longer than the table, and callers fall back to the exact path rather
 * than under-report.
 */
function tableIsAuthoritative(ctx, total) {
  return ctx.events.length <= total;
}

/** The historical read: merge table and mirror, sort, then filter in JS. */
function readAuditEvents(ctx, filters = {}) {
  let events = ctx.events;
  if (ctx.db && ctx.stmts) {
    const dbEvents = ctx.stmts.allAuditEvents.all().map(rowToEvent);
    const merged = new Map();
    for (const event of [...dbEvents, ...ctx.events]) {
      merged.set(event.auditId, cloneAuditEvent(event));
    }
    events = Array.from(merged.values()).sort((a, b) => {
      const timestampDiff = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
      if (timestampDiff !== 0) return timestampDiff;
      return String(a.auditId || '').localeCompare(String(b.auditId || ''));
    });
  }
  return filterAuditEvents(events, filters);
}

/** COUNT(*) with the same filter semantics as readAuditEvents(). */
function countAuditEvents(ctx, filters = {}) {
  if (!ctx.db || !ctx.stmts) {
    return filterAuditEvents(ctx.events, filters).length;
  }

  const total = Number(ctx.stmts.countAuditEvents.get()?.total ?? 0);
  if (!tableIsAuthoritative(ctx, total)) {
    return readAuditEvents(ctx, filters).length;
  }

  const { clauses, params, impossible } = buildAuditFilter(filters);
  if (impossible) return 0;
  if (!clauses.length) return total;

  const sql = `SELECT COUNT(*) AS total FROM audit_log WHERE ${clauses.join(' AND ')}`;
  return Number(prepare(ctx, sql).get(...params)?.total ?? 0);
}

/**
 * One keyset page of audit events, filters pushed into SQL.
 *
 * @returns {{items: Array, hasMore: boolean, nextCursor: string|null, limit: number}}
 */
function queryAuditEvents(ctx, options = {}) {
  const filters = options.filters || {};
  const order = options.order === 'desc' ? 'desc' : 'asc';
  const limit = clampAuditLimit(options.limit);
  const cursor = decodeAuditCursor(options.cursor);

  const page = (items) => {
    const hasMore = items.length > limit;
    const window = hasMore ? items.slice(0, limit) : items;
    return {
      items: window,
      hasMore,
      nextCursor: hasMore ? encodeAuditCursor(window[window.length - 1]) : null,
      limit,
    };
  };

  const useDb = ctx.db && ctx.stmts
    && tableIsAuthoritative(ctx, Number(ctx.stmts.countAuditEvents.get()?.total ?? 0));

  if (!useDb) {
    // Mirror-backed fallback: same ordering and cursor semantics, applied in
    // JS. Bounded by the same limit, so the response never grows with history.
    const all = readAuditEvents(ctx, filters).sort((a, b) => compareEvents(a, b, order));
    const start = cursor
      ? all.findIndex((event) => {
        const diff = compareEvents(event, { timestamp: cursor[0], targetId: cursor[1], auditId: cursor[2] }, order);
        return diff > 0;
      })
      : 0;
    if (start < 0) return page([]);
    return page(all.slice(start, start + limit + 1));
  }

  const { clauses, params, impossible } = buildAuditFilter(filters);
  if (impossible) return page([]);

  if (cursor) {
    clauses.push(`(${ORDER_COLUMNS}) ${order === 'desc' ? '<' : '>'} (?, ?, ?)`);
    params.push(cursor[0], cursor[1], cursor[2]);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  const sql = `SELECT * FROM audit_log ${where} ORDER BY timestamp ${direction}, `
    + `COALESCE(target_id, '') ${direction}, audit_id ${direction} LIMIT ?`;

  const rows = prepare(ctx, sql).all(...params, limit + 1);
  return page(rows.map(rowToEvent));
}

module.exports = {
  AUDIT_QUERY_DEFAULT_LIMIT,
  AUDIT_QUERY_MAX_LIMIT,
  AUDIT_FILTER_COLUMNS,
  buildAuditFilter,
  clampAuditLimit,
  compareEvents,
  countAuditEvents,
  decodeAuditCursor,
  encodeAuditCursor,
  queryAuditEvents,
  readAuditEvents,
};
