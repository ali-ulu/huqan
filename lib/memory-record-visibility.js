'use strict';

// #3493: the default-read visibility predicates.
//
// Before archive had a writer, several reads filtered the literal `'deleted'`
// only (get/findById, exportPackage, temporal). That is the same answer while
// 'archived' has no writer -- and a silent leak the moment one exists, because
// an archived record would still match `status !== 'deleted'`. The archived
// status is now folded into the same predicate each read already used, so a
// read cannot hide one hidden status and leak the other.
//
// There are deliberately TWO predicates, because the repository asks two
// different default-read questions and unifying them would change pinned
// behavior:
//   - the list/query family has always hidden every non-active record
//     (active-only; superseded and unknown are hidden too);
//   - temporal/export/findById have always hidden only 'deleted', leaving a
//     superseded record directly reachable (pinned by
//     test/memory-tombstone-supersede-downstream-exclusion.test.js).
// One predicate would silently change one of those; two keep both exact and
// add 'archived' to each.

/** Statuses that are never part of a default read. */
const HIDDEN_STATUSES = Object.freeze(['deleted', 'archived']);

/** True when `record` is present and carries a hidden status. */
function isHiddenStatus(record) {
  return !!record && HIDDEN_STATUSES.includes(record.status);
}

/** True only for an archived record; the restore path's precondition. */
function isArchived(record) {
  return !!record && record.status === 'archived';
}

/**
 * The active-only read set (list, findBy, query, search, link reads). A record
 * is hidden unless it is active, unless the caller asked for the whole audit set
 * (`includeDeleted`/`includeTombstoned`), or unless it is archived and the
 * caller asked for archived records (`includeArchived`).
 */
function isHiddenByDefault(record, opts = {}) {
  if (!record) return true;
  if (opts.includeDeleted === true || opts.includeTombstoned === true) return false;
  if (record.status === 'active') return false;
  if (record.status === 'archived' && opts.includeArchived === true) return false;
  return true;
}

/**
 * The tombstone-aware read set (temporal/export/findById): only 'deleted' and
 * 'archived' are hidden; a superseded record stays reachable. `includeTombstoned`
 * reveals both; `includeArchived` reveals archived only.
 */
function isTombstonedOrArchived(record, opts = {}) {
  if (!isHiddenStatus(record)) return false;
  if (opts.includeTombstoned === true) return false;
  if (record.status === 'archived' && opts.includeArchived === true) return false;
  return true;
}

module.exports = {
  HIDDEN_STATUSES,
  isHiddenStatus,
  isArchived,
  isHiddenByDefault,
  isTombstonedOrArchived,
};
