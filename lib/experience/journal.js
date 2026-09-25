'use strict';

/**
 * Experience Core E2 — ExperienceJournal (#2377).
 *
 * The second of the three Experience Core abstractions: the durable append
 * surface and the read side that later layers derive from. E1
 * (`./contract.js`) judges; this module remembers. Structural admission
 * reuses the contract's pure checks, but the authoritative ledger — sequence
 * assignment, idempotency, conflict detection, closure — lives here.
 *
 * ## Guarantees
 *
 * - **Durable** — when a `store` is injected, every acknowledged append is
 *   committed inside `store.withTransaction` to the `experience_journal`
 *   table, so it survives a process kill. SQLite makes each single-row
 *   insert atomic; a crash can only lose the unacknowledged tail, never
 *   tear a committed row. Without a store the journal is hermetic
 *   in-memory (which is what the contract tests use).
 * - **Ordered** — `sequence` is gapless and monotonic per run. The writer
 *   never assigns it: an event carrying `sequence` is refused, and the next
 *   value is assigned inside the store transaction (or synchronously in
 *   memory), so concurrent writers serialise rather than interleave.
 * - **Complete** — a journal that cannot write fails closed. When the store
 *   throws, `append` returns `{ ok: false, code: 'persist_failed' }` and the
 *   in-memory ledger is left untouched. This is the line between Experience
 *   and `lib/observability/`, which is explicitly best-effort.
 * - **Integrity-protected** — every stored record carries a SHA-256 over its
 *   canonical form. `read` recomputes it and throws (`INTEGRITY_MISMATCH`)
 *   rather than returning a record altered outside the journal.
 * - **Closed is closed** — after `run_closed` (event or `close()`), an
 *   append is refused, including from a writer still holding a handle.
 *
 * ## Read side (enough for later layers, no more)
 *
 * Fetch a run (`read`), resolve parent links (`parentOf`) and attempt
 * grouping (`runsForAttempt`), and read the closing manifest with its
 * `learningEligibility`. No aggregation, no scoring, no compilation.
 *
 * ## Storage decision (recorded per the issue)
 *
 * `storage.js` owns SQLite and its `withTransaction` seam, so no second
 * persistence engine is introduced: the journal receives a store (DIP #2118
 * — it never constructs one) and uses `store.db` when present. Crash
 * reconciliation stays a separate delivery (#2399); this file only
 * guarantees that what was acknowledged is on disk and untorn.
 *
 * ## Deliberate deviations from a strict contract reading
 *
 * - The first event need not be `run_started`. The E0-b RED harness opens
 *   runs with `action_proposed`, and the vocabulary is extensible by design;
 *   what is enforced is: known type, at most one `run_started`, and nothing
 *   after close.
 * - The E1 repair-approval rule is not re-checked here: the journal tracks
 *   no approvals, and that rule already has its own test on the contract.
 */

const crypto = require('node:crypto');
const {
  EVENT_TYPES,
  validateEventShape,
  checkCausality,
  resolveLearningEligibility,
} = require('./contract');
const { isPlainObject } = require('../is-plain-object');

const TABLE = 'experience_journal';

const CODES = Object.freeze({
  TERMINAL_RUN: 'terminal_run',
  WORKSPACE_MISMATCH: 'workspace_mismatch',
  SEQUENCE_RESERVED: 'sequence_reserved',
  DUPLICATE_RUN_STARTED: 'duplicate_run_started',
  PAYLOAD_CONFLICT: 'payload_conflict',
  STALE_HEAD: 'stale_head',
  UNKNOWN_CAUSALITY_REF: 'unknown_causality_ref',
  ATTEMPT_CONFLICT: 'attempt_conflict',
  PERSIST_FAILED: 'persist_failed',
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Deterministic JSON: sorted keys, no spacing. Payloads are opaque blobs. */
function stableJson(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Identity-relevant content for idempotency: everything but sequence/hash. */
function contentKey(event) {
  return [
    event.runId,
    event.eventId,
    event.type,
    event.workspaceId || '',
    event.attemptId || '',
    event.invocationId || '',
    event.causedByEventId || '',
    event.parentRunId || '',
    event.executionStatus || '',
    event.outcomeStatus || '',
    event.verdict || '',
    stableJson(event.payload),
    stableJson(event.proofs),
    stableJson(event.approvalId),
  ].join('|');
}

function recordHash({ runId, eventId, sequence, type, workspaceId, attemptId, invocationId,
  causedByEventId, parentRunId, executionStatus, outcomeStatus, verdict, payload, proofs, approvalId }) {
  return sha256([
    runId, eventId, sequence, type, workspaceId || '', attemptId || '',
    invocationId || '', causedByEventId || '', parentRunId || '',
    executionStatus || '', outcomeStatus || '', verdict || '',
    stableJson(payload), stableJson(proofs), stableJson(approvalId),
  ].join('|'));
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (run_id, event_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_run_seq ON ${TABLE} (run_id, sequence)`);
}

function toStored(event, sequence) {
  const stored = {
    runId: event.runId,
    workspaceId: event.workspaceId,
    eventId: event.eventId,
    type: event.type,
    sequence,
  };
  for (const field of ['attemptId', 'invocationId', 'causedByEventId', 'parentRunId',
    'executionStatus', 'outcomeStatus', 'verdict', 'payload', 'proofs', 'approvalId']) {
    if (event[field] !== undefined) stored[field] = event[field];
  }
  stored.hash = recordHash(stored);
  return Object.freeze(stored);
}

/** Public copy: everything the writer stored plus sequence, minus the seal. */
function publicEvent(stored) {
  const copy = { ...stored };
  delete copy.hash;
  return Object.freeze(copy);
}

function verifyRecord(stored) {
  const { hash, ...rest } = stored;
  return hash === recordHash({ ...rest, sequence: stored.sequence });
}

/**
 * Create a journal. `store` is optional and injected, never constructed:
 * `{ withTransaction(fn), db? }`. `db`, when present, is a better-sqlite3
 * handle used for the `experience_journal` table.
 */
function createExperienceJournal({ store } = {}) {
  const runs = new Map();
  const attempts = new Map();
  const parents = new Map();
  // Runs with at least one row that failed verification during rebuild.
  // Their reads refuse rather than returning a silently truncated history.
  const tainted = new Set();
  const useTx = store && typeof store.withTransaction === 'function'
    ? (fn) => store.withTransaction(fn)
    : (fn) => fn();
  const db = store && store.db ? store.db : null;
  if (db) ensureTable(db);

  function getRun(runId) {
    return runs.get(runId) || null;
  }

  function commitMemory(runId, stored) {
    let run = runs.get(runId);
    if (!run) {
      run = {
        workspaceId: stored.workspaceId,
        events: [],
        byId: new Map(),
        seenIds: new Set(),
        types: [],
        closed: false,
        head: 0,
      };
      runs.set(runId, run);
    }
    run.events.push(stored);
    run.byId.set(stored.eventId, stored);
    run.seenIds.add(stored.eventId);
    run.types.push(stored.type);
    run.head = stored.sequence;
    if (stored.attemptId) attempts.set(stored.attemptId, runId);
    if (stored.parentRunId) parents.set(runId, stored.parentRunId);
    if (stored.type === EVENT_TYPES.RUN_CLOSED) run.closed = true;
  }

  function persistRow(stored) {
    if (!db) return;
    const { hash, ...body } = stored;
    db.prepare(`INSERT INTO ${TABLE} (run_id, event_id, sequence, workspace_id, type, body, hash)`
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(stored.runId, stored.eventId, stored.sequence, stored.workspaceId,
        stored.type, stableJson(body), stored.hash);
  }

  function append(event, opts = {}) {
    if (!isPlainObject(event)) return { ok: false, code: 'invalid_event' };
    const shape = validateEventShape(event);
    if (!shape.ok) return { ok: false, code: shape.code };
    if (event.sequence !== undefined) return { ok: false, code: CODES.SEQUENCE_RESERVED };

    const workspaceId = nonEmptyString(event.workspaceId) || 'default';
    const run = getRun(event.runId);
    // Idempotency before closure: an at-least-once writer retrying an
    // already-stored event learns `duplicate: true` rather than a refusal;
    // it mutates nothing, so closed-is-closed still holds for new events.
    if (run && run.byId.has(event.eventId)) {
      const prior = run.byId.get(event.eventId);
      if (contentKey({ ...event, workspaceId }) === contentKey(prior)) {
        return { ok: true, duplicate: true, sequence: prior.sequence };
      }
      return { ok: false, code: CODES.PAYLOAD_CONFLICT };
    }
    if (run && run.closed) return { ok: false, code: CODES.TERMINAL_RUN };
    if (run && run.workspaceId !== workspaceId) {
      return { ok: false, code: CODES.WORKSPACE_MISMATCH };
    }
    if (event.type === EVENT_TYPES.RUN_STARTED && run && run.types.includes(EVENT_TYPES.RUN_STARTED)) {
      return { ok: false, code: CODES.DUPLICATE_RUN_STARTED };
    }

    const head = run ? run.head : 0;
    if (opts && opts.expectedHead !== undefined && opts.expectedHead !== null
      && Number(opts.expectedHead) !== head) {
      return { ok: false, code: CODES.STALE_HEAD };
    }

    const causality = checkCausality(run ? run.seenIds : new Set(), event);
    if (!causality.ok) return { ok: false, code: CODES.UNKNOWN_CAUSALITY_REF };

    if (nonEmptyString(event.attemptId)) {
      const bound = attempts.get(event.attemptId);
      if (bound && bound !== event.runId) return { ok: false, code: CODES.ATTEMPT_CONFLICT };
    }

    const stored = toStored({ ...event, workspaceId }, head + 1);
    try {
      useTx(() => persistRow(stored));
    } catch (_) {
      return { ok: false, code: CODES.PERSIST_FAILED };
    }
    // Commit memory only after the transaction returned successfully. A
    // rollback raised after the callback removes the durable row, so
    // recording the event in memory here would let this instance's read,
    // duplicate check and next-sequence assignment disagree with the
    // restarted store — the fail-closed guarantee has to cover both sides.
    commitMemory(event.runId, stored);
    return { ok: true, duplicate: false, sequence: stored.sequence };
  }

  function read(runId, opts = {}) {
    if (tainted.has(runId)) {
      const error = new Error(`experience record altered outside the journal: ${runId}`);
      error.code = CODES.INTEGRITY_MISMATCH;
      error.runId = runId;
      throw error;
    }
    const run = getRun(runId);
    if (!run) return [];
    if (opts && nonEmptyString(opts.workspaceId) && opts.workspaceId !== run.workspaceId) return [];
    for (const stored of run.events) {
      if (!verifyRecord(stored)) {
        const error = new Error(`experience record altered outside the journal: ${runId}/${stored.eventId}`);
        error.code = CODES.INTEGRITY_MISMATCH;
        error.runId = runId;
        error.eventId = stored.eventId;
        throw error;
      }
    }
    return run.events.map(publicEvent);
  }

  function close(runId) {
    const run = getRun(runId);
    if (run) run.closed = true;
    else {
      runs.set(runId, {
        workspaceId: 'default', events: [], byId: new Map(), seenIds: new Set(),
        types: [EVENT_TYPES.RUN_CLOSED], closed: true, head: 0,
      });
    }
    return { ok: true };
  }

  function manifest(runId) {
    const run = getRun(runId);
    if (!run) {
      return Object.freeze({
        runId, closed: false, eventCount: 0, head: 0,
        outcomeStatus: 'unknown', learningEligibility: 'ineligible',
      });
    }
    let executionStatus;
    let outcomeStatus = 'unknown';
    let proofs;
    let verificationConflicting;
    let failureEvidence;
    for (const stored of run.events) {
      if (stored.type === EVENT_TYPES.EXECUTION_FINISHED && stored.executionStatus) {
        executionStatus = stored.executionStatus;
      }
      if (stored.type === EVENT_TYPES.FAILURE && stored.payload !== undefined) failureEvidence = true;
      if (stored.type === EVENT_TYPES.VERIFICATION) {
        const verdict = stored.verdict || stored.outcomeStatus;
        if (outcomeStatus !== 'unknown' && verdict && verdict !== outcomeStatus) {
          verificationConflicting = true;
        }
        if (verdict) outcomeStatus = verdict;
        if (stored.proofs !== undefined) proofs = stored.proofs;
      }
    }
    const eligibility = resolveLearningEligibility({
      executionStatus, outcomeStatus, verificationConflicting,
      proofs: proofs || (failureEvidence ? { failureEvidence: true } : undefined),
    });
    return Object.freeze({
      runId, closed: run.closed, eventCount: run.events.length, head: run.head,
      executionStatus: executionStatus || 'unknown',
      outcomeStatus,
      learningEligibility: eligibility.eligibility,
    });
  }

  function runsForAttempt(attemptId) {
    const runId = attempts.get(attemptId);
    return runId ? [runId] : [];
  }

  function parentOf(runId) {
    return parents.get(runId);
  }

  // Rebuild the read cache from the store when one is injected, so an
  // acknowledged append survives a process kill (durable). Runs in the
  // factory because better-sqlite3 is synchronous.
  if (db) {
    const rows = db.prepare(`SELECT run_id, body, hash FROM ${TABLE} ORDER BY run_id, sequence`).all();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.body);
        const stored = Object.freeze({ ...parsed, hash: row.hash });
        if (!verifyRecord(stored)) {
          tainted.add(row.run_id);
          continue;
        }
        commitMemory(row.run_id, stored);
      } catch (_) {
        // A single unreadable row must not take down the rebuild; integrity
        // failures still surface when the affected run is read.
        tainted.add(row.run_id);
      }
    }
    // Sequence continuity: head follows the highest stored sequence per run.
    for (const run of runs.values()) {
      let max = 0;
      for (const stored of run.events) max = Math.max(max, stored.sequence);
      run.head = max;
    }
  }

  return Object.freeze({ append, read, close, manifest, runsForAttempt, parentOf });
}

module.exports = Object.freeze({ createExperienceJournal, TABLE, CODES });
