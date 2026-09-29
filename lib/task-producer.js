'use strict';

/**
 * HUQAN Coder — task producer.
 *
 * The coder path is finished and the entry to it does not exist. `huqan coder
 * <task.json>` runs a transform, gates the patch and writes it to disk — but
 * the task arrives as a hand-written JSON file, so the only way an observed
 * failure becomes a change is for somebody to retype the fix as a task. The
 * step in between, "this verified failure maps to this bounded transform", was
 * never built.
 *
 * This module is that step, and nothing more. It is a pure projection:
 *
 *   failure_record  ->  candidate transform task
 *
 * The properties that make it safe to sit in front of a gate are all negative
 * ones, so they are worth stating explicitly:
 *
 *   It does not execute. It never calls runTask and never touches the
 *   filesystem — no reads, no writes. Everything it returns is data for the
 *   existing applyDerivation path, which is still what reads, gates and
 *   writes. A bug here can produce a useless task; it cannot produce a change.
 *
 *   It does not guess. A failure it cannot map to one of the runner's four
 *   supported operations returns NEEDS_HUMAN_DECISION, never a fabricated task.
 *   An unfillable hole in a task contract is a hole the human still has to
 *   look at; a confidently invented `find` string is a change nobody agreed to.
 *
 *   It does not widen authority. It adds no decision level, no receipt family
 *   and no auto-apply path. The task it emits carries `allowedPaths` and an
 *   `operation` and nothing else the gate is not already going to ask for, so
 *   passing through code-change-gate is exactly as informative as it already
 *   was — the producer adds no way around it.
 *
 * The mapping is deliberately narrow: replace_text, from a failure whose
 * `expected` and `observed` are both known. That is the one shape where the
 * fix is fully determined by the record itself. `insert_after` and
 * `rename_identifier` need an anchor or an identifier name the failure record
 * does not carry, and `json_schema_route_test` needs a whole schema, so all
 * three return NEEDS_HUMAN_DECISION rather than a guess. Widening the catalog
 * is a separate delivery (see docs/coder-catalog-notes.md).
 */

const path = require('node:path');

const PRODUCER_STATUSES = Object.freeze({
  TASK_PRODUCED: 'TASK_PRODUCED',
  NEEDS_HUMAN_DECISION: 'NEEDS_HUMAN_DECISION',
});

/**
 * Reasons a failure is not projected onto a task. Each one is a real shape a
 * failure record can have, not an error class: an unmappable failure is a
 * normal outcome of this function, and naming the reason is what lets a
 * caller tell "we could not decide" apart from "we decided no".
 */
const PRODUCER_REASONS = Object.freeze({
  FAILURE_NOT_OBJECT: 'FAILURE_NOT_OBJECT',
  FAILURE_KIND_INVALID: 'FAILURE_KIND_INVALID',
  FAILURE_ID_MISSING: 'FAILURE_ID_MISSING',
  FAILURE_NOT_VERIFIED: 'FAILURE_NOT_VERIFIED',
  FAILURE_PATH_MISSING: 'FAILURE_PATH_MISSING',
  FAILURE_PATH_ESCAPES_ROOT: 'FAILURE_PATH_ESCAPES_ROOT',
  FAILURE_EXPECTED_MISSING: 'FAILURE_EXPECTED_MISSING',
  FAILURE_OBSERVED_MISSING: 'FAILURE_OBSERVED_MISSING',
  FAILURE_EXPECTED_EQUALS_OBSERVED: 'FAILURE_EXPECTED_EQUALS_OBSERVED',
  NO_SUPPORTED_OPERATION: 'NO_SUPPORTED_OPERATION',
  REPLACEMENT_NOT_UNIQUE: 'REPLACEMENT_NOT_UNIQUE',
});

/**
 * Only one operation is projectable today, and the mapping is stated as data
 * rather than a switch so that adding a second one later is a row here rather
 * than a branch through the producer.
 *
 * `expected` is the text the failure says *should* have been there, `observed`
 * is what was there instead. The transform therefore searches for `observed`
 * and writes `expected` — the direction matters, and getting it backwards
 * would produce a patch that makes the code match the failure rather than fix
 * it.
 */
const PROJECTABLE_OPERATIONS = Object.freeze({
  REPLACE_TEXT: 'replace_text',
});

const OPERATION_BY_FAILURE_ACTION = Object.freeze({
  replace_text: PROJECTABLE_OPERATIONS.REPLACE_TEXT,
});

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A task that cannot be projected. `task: null` is the load-bearing field: a
 * caller that wants a task either gets a complete one or gets nothing, and
 * cannot accidentally proceed with a half-built contract.
 */
function needsHumanDecision(reason, context = {}) {
  return {
    status: PRODUCER_STATUSES.NEEDS_HUMAN_DECISION,
    reason,
    task: null,
    sourceFailureId: context.failureId || '',
    operationType: context.operationType || '',
  };
}

function produced(task, context = {}) {
  return {
    status: PRODUCER_STATUSES.TASK_PRODUCED,
    reason: null,
    task,
    sourceFailureId: context.failureId || '',
    operationType: task.operation.type,
  };
}

/**
 * The failure's path has to already be repo-relative. This is a lexical check
 * only — no filesystem is consulted — and it exists so that a path from an
 * untrusted failure record cannot smuggle an absolute location or a `..`
 * segment into a task's allowedPaths. The authoritative containment check is
 * resolvePathWithinRoot() in lib/coder/apply-derivation.js, which runs again
 * before anything is read; this is the first of the two, not the only one.
 */
function pathIsRepoRelative(candidate) {
  const cleaned = cleanString(candidate).replace(/\\/gu, '/');
  if (!cleaned) return false;
  if (cleaned.startsWith('/')) return false;
  // Windows drive-qualified paths (`C:/x`) are absolute on this platform and
  // must not be treated as repo-relative on a machine that happens to accept
  // the same string.
  if (/^[a-zA-Z]:/u.test(cleaned)) return false;
  const normalized = path.posix.normalize(cleaned);
  if (normalized === '.' || normalized === '..') return false;
  if (normalized.startsWith('../')) return false;
  return true;
}

function normalizedFailurePath(failure) {
  const raw = failure.action && typeof failure.action.path === 'string' ? failure.action.path : '';
  const cleaned = cleanString(raw).replace(/\\/gu, '/');
  if (!cleaned) return { ok: false, reason: PRODUCER_REASONS.FAILURE_PATH_MISSING };
  if (!pathIsRepoRelative(cleaned)) {
    return { ok: false, reason: PRODUCER_REASONS.FAILURE_PATH_ESCAPES_ROOT };
  }
  return { ok: true, path: cleaned };
}

/**
 * Which catalog operation, if any, a failure names. A failure record's
 * `action.operation` is the free-text operation the failing call declared; it
 * is normalized to lower case by lib/error-prevention/fingerprint.js. An
 * operation that is not in the projectable set is not an error — it is the
 * common case, and it must not be reported as a malformed record.
 */
function projectableOperationType(failure) {
  const declared = cleanString(failure.action && failure.action.operation).toLowerCase();
  return OPERATION_BY_FAILURE_ACTION[declared] || '';
}

/**
 * Project one verified failure onto a candidate transform task.
 *
 * `options.files` is optional and, when present, is used for one thing only:
 * rejecting a replacement that does not occur exactly once in the file. That
 * check is a courtesy — the runner performs the same check authoritatively and
 * would answer REPLACEMENT_NOT_UNIQUE anyway — and it is only possible when
 * the caller happens to hold the content. It never reads from disk to find
 * out, because a producer that read the tree would be doing the coder's job
 * and would need the coder's permissions to do it.
 */
function produceTask(failure, options = {}) {
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
    return needsHumanDecision(PRODUCER_REASONS.FAILURE_NOT_OBJECT);
  }
  if (failure.kind !== 'failure_record') {
    return needsHumanDecision(PRODUCER_REASONS.FAILURE_KIND_INVALID);
  }

  const failureId = cleanString(failure.failureId);
  if (!failureId) return needsHumanDecision(PRODUCER_REASONS.FAILURE_ID_MISSING);

  // Trust is the whole reason this function is allowed to exist in front of a
  // write path. An unverified or candidate failure describes something
  // somebody observed, not something established; deriving an edit from it
  // would be acting on a report.
  if (failure.verificationStatus !== 'verified') {
    return needsHumanDecision(PRODUCER_REASONS.FAILURE_NOT_VERIFIED, { failureId });
  }

  const operationType = projectableOperationType(failure);
  if (!operationType) {
    return needsHumanDecision(PRODUCER_REASONS.NO_SUPPORTED_OPERATION, { failureId });
  }

  const declaredPath = normalizedFailurePath(failure);
  if (!declaredPath.ok) return needsHumanDecision(declaredPath.reason, { failureId, operationType });

  const find = typeof failure.observed === 'string' ? failure.observed : '';
  const replace = typeof failure.expected === 'string' ? failure.expected : '';
  if (!find) return needsHumanDecision(PRODUCER_REASONS.FAILURE_OBSERVED_MISSING, { failureId, operationType });
  if (!replace) return needsHumanDecision(PRODUCER_REASONS.FAILURE_EXPECTED_MISSING, { failureId, operationType });
  if (find === replace) {
    return needsHumanDecision(PRODUCER_REASONS.FAILURE_EXPECTED_EQUALS_OBSERVED, { failureId, operationType });
  }

  const content = options.files && typeof options.files === 'object' ? options.files[declaredPath.path] : undefined;
  if (typeof content === 'string' && content.split(find).length - 1 !== 1) {
    return needsHumanDecision(PRODUCER_REASONS.REPLACEMENT_NOT_UNIQUE, { failureId, operationType });
  }

  // `files` is empty on purpose. apply-derivation reads the declared paths
  // itself and merges what it read over this object, so a task that arrived
  // from a file on disk is treated exactly like one that came from a failure
  // record. The field is present only because the runner's contract requires
  // an object here.
  const task = {
    // Derived from the failure id, not generated: the same verified failure
    // must project to the same task id on every run, or the derivation record
    // could not tell a re-run from a new decision.
    id: `task-${failureId}`,
    level: 'l0',
    intent: `repair verified failure ${failureId}: restore expected content in ${declaredPath.path}`,
    allowedPaths: [declaredPath.path],
    operation: { type: operationType, path: declaredPath.path, find, replace },
    files: {},
  };

  return produced(task, { failureId });
}

module.exports = {
  PRODUCER_REASONS,
  PRODUCER_STATUSES,
  PROJECTABLE_OPERATIONS,
  produceTask,
};
