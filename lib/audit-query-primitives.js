'use strict';

/**
 * Pure audit-query primitives (issue #2270).
 *
 * The caller-facing half of the audit read surface: limit clamping, cursor
 * encode/decode, filter construction, event comparison and the row -> event
 * mapping. Nothing here touches a database, a prepared statement or a context,
 * so it is a pure function of its arguments and can be characterised without
 * SQLite. The SQL-backed reader that uses these lives in ./audit-query.js,
 * which re-exports this surface so callers keep one entry point.
 *
 * Why the split: audit-query.js put two jobs in one file — deciding what a
 * caller is asking for, and answering it against the table. Length was only
 * the symptom; the boundary was the reason.
 *
 * @typedef {object} AuditEvent
 * @property {string} auditId
 * @property {string} eventType
 * @property {string} targetType
 * @property {string} targetId
 * @property {string} workspaceId
 * @property {string} actor
 * @property {string} timestamp
 * @property {string} sourceRef
 * @property {string} provenanceId
 * @property {string} trustPolicyVersion
 * @property {object} details
 */

const { normalizeAuditEvent } = require('./audit-log');

const AUDIT_QUERY_DEFAULT_LIMIT = 100;
const AUDIT_QUERY_MAX_LIMIT = 500;

/**
 * Audit filter key -> audit_log column. workspaceId is deliberately absent:
 * its empty-string case means "no workspace", which is not a plain equality.
 */
const AUDIT_FILTER_COLUMNS = Object.freeze([
  ['auditId', 'audit_id'],
  ['eventType', 'event_type'],
  ['targetType', 'target_type'],
  ['targetId', 'target_id'],
  ['actor', 'actor'],
  ['provenanceId', 'provenance_id'],
  ['trustPolicyVersion', 'trust_policy_version'],
  ['sourceRef', 'source_ref'],
]);

function rowToEvent(row) {
  return normalizeAuditEvent({
    auditId: row.audit_id,
    eventType: row.event_type,
    targetType: row.target_type || '',
    targetId: row.target_id || '',
    workspaceId: row.workspace_id || 'default',
    actor: row.actor || 'system',
    timestamp: row.timestamp,
    sourceRef: row.source_ref || '',
    provenanceId: row.provenance_id || '',
    trustPolicyVersion: row.trust_policy_version || '',
    details: JSON.parse(row.details || '{}'),
  });
}

function sortKey(event) {
  return [
    String(event?.timestamp || ''),
    String(event?.targetId || ''),
    String(event?.auditId || ''),
  ];
}

function compareEvents(left, right, order = 'asc') {
  const a = sortKey(left);
  const b = sortKey(right);
  for (let i = 0; i < a.length; i++) {
    const diff = a[i].localeCompare(b[i]);
    if (diff !== 0) return order === 'desc' ? -diff : diff;
  }
  return 0;
}

/** Clamp a caller-supplied limit into the servable range. */
function clampAuditLimit(value, fallback = AUDIT_QUERY_DEFAULT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(AUDIT_QUERY_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

/** Opaque cursor naming the last event of a page. */
function encodeAuditCursor(event) {
  if (!event) return null;
  const [timestamp, targetId, auditId] = sortKey(event);
  return Buffer.from(JSON.stringify([timestamp, targetId, auditId]), 'utf8').toString('base64url');
}

function decodeAuditCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    return parsed.map((part) => String(part ?? ''));
  } catch (_) {
    return null;
  }
}

/**
 * Build the WHERE fragment shared by the count and page queries.
 * `impossible` marks a filter no stored row can satisfy, so the caller can
 * answer without touching the database at all.
 */
function buildAuditFilter(filters = {}) {
  const clauses = [];
  const params = [];

  for (const [key, column] of AUDIT_FILTER_COLUMNS) {
    const value = filters?.[key];
    if (!value) continue;
    clauses.push(`${column} = ?`);
    params.push(String(value));
  }

  // Mirrors normalizeWorkspaceFilter(): absent or null means "every
  // workspace"; an empty string means "events with no workspace", which no
  // stored row satisfies because rows default to 'default'.
  if (Object.prototype.hasOwnProperty.call(filters || {}, 'workspaceId')) {
    const raw = filters.workspaceId;
    if (raw !== undefined && raw !== null) {
      if (typeof raw === 'string' && !raw.trim()) return { clauses, params, impossible: true };
      clauses.push('COALESCE(workspace_id, ?) = ?');
      params.push('default', String(raw));
    }
  }

  return { clauses, params, impossible: false };
}

module.exports = {
  AUDIT_QUERY_DEFAULT_LIMIT,
  AUDIT_QUERY_MAX_LIMIT,
  AUDIT_FILTER_COLUMNS,
  buildAuditFilter,
  clampAuditLimit,
  compareEvents,
  decodeAuditCursor,
  encodeAuditCursor,
  rowToEvent,
};
