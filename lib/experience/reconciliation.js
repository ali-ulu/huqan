'use strict';

/**
 * Experience E5 — crash recovery and external-effect reconciliation (#2399).
 *
 * A crash-safe operation ledger for the intent/outcome pairs the journal
 * records. The journal remembers events; this module answers the question
 * the journal cannot: "did the outside world already feel this operation?"
 * An external API is never assumed exactly-once, so every effect carries
 * an operation ID and the ledger makes a retry return the recorded outcome
 * instead of performing the effect again.
 *
 * ## Why not reuse lib/external-client-replay-store.js
 *
 * That store guards the external-client package authority (replay keys,
 * trusted keys, permissions). This ledger guards Experience runs (operation
 * IDs linked to run IDs, with journal linkage for late outcomes). Merging
 * them would couple two authority boundaries that fail for different
 * reasons, so the small duplication of a claim-once table is deliberate.
 *
 * ## Guarantees
 *
 * - **Intent before effect** — `begin` records the intent durably. If the
 *   append fails, the caller must not perform the effect (`persist_failed`
 *   fails closed, like the journal).
 * - **Restart preserves doubt** — a restart never completes a pending
 *   operation. `reconcile` lists pendings as `pending`/`unknown`; the
 *   caller verifies against the outside world before retrying. A blind
 *   retry that duplicates an external effect is the failure this module
 *   exists to prevent.
 * - **One winner** — two writers racing on one operation ID serialise in
 *   the store transaction. Same intent is a harmless duplicate; a
 *   different intent or run is a conflict, never a silent overwrite.
 * - **Closed stays closed** — a late outcome for a closed run never
 *   mutates it. `lateOutcome` returns a plan for a linked run
 *   (`parentRunId` points at the closed run) carrying the outcome as a new
 *   assessment. The caller appends it through the journal.
 * - **No torn rows** — every state change is one transactional write, so a
 *   kill at any instant leaves each row either pending or completed.
 * - **Unavailable is not empty** — a store that cannot be read or written
 *   refuses `begin`, so no effect runs without its intent on record.
 *
 * ## Storage
 *
 * Same decision as the journal: no second engine. The ledger receives a
 * store (DIP) and uses its better-sqlite3 handle plus `withTransaction`.
 * It owns exactly one table (`experience_operations`). Without a store it
 * is hermetic in-memory. Connection ownership stays with the injected
 * store — this module never opens, closes or checkpoints the database.
 */

const crypto = require('node:crypto');

const TABLE = 'experience_operations';

const STATES = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const CODES = Object.freeze({
  OPERATION_CONFLICT: 'operation_conflict',
  UNKNOWN_OPERATION: 'unknown_operation',
  BAD_TRANSITION: 'bad_transition',
  PERSIST_FAILED: 'persist_failed',
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableJson(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    operation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    intent_hash TEXT NOT NULL,
    intent_body TEXT NOT NULL,
    state TEXT NOT NULL,
    outcome_body TEXT,
    updated_at INTEGER NOT NULL
  )`);
}

function toRecord(row) {
  return Object.freeze({
    operationId: row.operation_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    intent: JSON.parse(row.intent_body),
    state: row.state,
    outcome: row.outcome_body == null ? null : JSON.parse(row.outcome_body),
    updatedAt: row.updated_at,
  });
}

/**
 * Create an operation ledger. `store` is optional and injected, never
 * constructed: `{ withTransaction(fn), db? }`.
 *
 * With a `db` the table is the only authority: every read goes to the live
 * handle, so a restart, a second ledger on the same file and a handle the
 * owner reopened after restore (`journal-connection.js#reopen`) all see the
 * same rows, and nothing is loaded into memory up front. A store whose `db`
 * is currently null (closed) is unavailable, not empty: writes fail closed
 * and reads report the operation as unknown. Without a `db` the ledger is
 * hermetic in-memory.
 */
function createOperationLedger({ store } = {}) {
  const memory = new Map();
  const durable = Boolean(store && typeof store === 'object' && 'db' in store);
  const useTx = store && typeof store.withTransaction === 'function'
    ? (fn) => store.withTransaction(fn)
    : (fn) => fn();
  let preparedDb = null;

  // The handle is read on every call and the table ensured once per handle,
  // because the owner may swap the handle underneath this ledger.
  function liveDb() {
    const db = durable ? store.db : null;
    if (db && db !== preparedDb) {
      ensureTable(db);
      preparedDb = db;
    }
    return db;
  }

  function find(operationId) {
    if (!durable) return memory.get(operationId) || null;
    const db = liveDb();
    if (!db) return null;
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE operation_id = ?`).get(operationId);
    return row ? toRecord(row) : null;
  }

  function insert(record) {
    if (!durable) {
      memory.set(record.operationId, record);
      return;
    }
    const db = liveDb();
    if (!db) throw new Error('operation ledger store is closed');
    db.prepare(`INSERT INTO ${TABLE}`
      + ' (operation_id, run_id, workspace_id, intent_hash, intent_body, state, outcome_body, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.operationId, record.runId, record.workspaceId,
        sha256(stableJson(record.intent)), stableJson(record.intent),
        record.state, record.outcome == null ? null : stableJson(record.outcome),
        record.updatedAt);
  }

  function update(record) {
    if (!durable) {
      memory.set(record.operationId, record);
      return;
    }
    const db = liveDb();
    if (!db) throw new Error('operation ledger store is closed');
    db.prepare(`UPDATE ${TABLE} SET state = ?, outcome_body = ?, updated_at = ? WHERE operation_id = ?`)
      .run(record.state, record.outcome == null ? null : stableJson(record.outcome), record.updatedAt, record.operationId);
  }

  // A read that throws is an unavailable store, reported as "not found" to
  // the read-only callers; `begin` and `complete` check it themselves so a
  // broken store fails closed there instead.
  function tryFind(operationId) {
    try {
      return find(operationId);
    } catch (_) {
      return null;
    }
  }

  function sameIntent(record, runId, intent) {
    return record.runId === runId && stableJson(record.intent) === stableJson(intent || null);
  }

  function duplicateOrConflict(record, runId, intent) {
    if (sameIntent(record, runId, intent)) return { ok: true, duplicate: true, state: record.state };
    return { ok: false, code: CODES.OPERATION_CONFLICT };
  }

  /**
   * Record intent before performing any external effect. The effect must
   * only happen when this returns `ok: true`.
   */
  function begin({ operationId, runId, workspaceId, intent } = {}) {
    if (!nonEmptyString(operationId) || !nonEmptyString(runId)) {
      return { ok: false, code: 'invalid_operation' };
    }
    let existing;
    try {
      existing = find(operationId);
    } catch (_) {
      return { ok: false, code: CODES.PERSIST_FAILED };
    }
    if (existing) return duplicateOrConflict(existing, runId, intent);
    const record = Object.freeze({
      operationId, runId, workspaceId: nonEmptyString(workspaceId) || 'default',
      intent: intent === undefined ? null : intent,
      state: STATES.PENDING, outcome: null, updatedAt: Date.now(),
    });
    try {
      useTx(() => insert(record));
    } catch (err) {
      // A UNIQUE violation means a concurrent writer won the race: re-read
      // the winner rather than reporting a store failure.
      const winner = err && /UNIQUE constraint failed/i.test(String(err.message)) ? tryFind(operationId) : null;
      return winner ? duplicateOrConflict(winner, runId, intent) : { ok: false, code: CODES.PERSIST_FAILED };
    }
    return { ok: true, duplicate: false, state: STATES.PENDING };
  }

  /** Replay-safe read: returns the recorded outcome, never performs work. */
  function claim(operationId) {
    const record = tryFind(operationId);
    if (!record) return { ok: false, code: CODES.UNKNOWN_OPERATION };
    if (record.state === STATES.PENDING) return { ok: true, state: record.state, outcome: null };
    return { ok: true, state: record.state, outcome: record.outcome };
  }

  /** Record the external effect's outcome. Pending → completed/failed only. */
  function complete({ operationId, outcome, failed = false } = {}) {
    let record;
    try {
      record = find(operationId);
    } catch (_) {
      return { ok: false, code: CODES.PERSIST_FAILED };
    }
    if (!record) return { ok: false, code: CODES.UNKNOWN_OPERATION };
    if (record.state !== STATES.PENDING) return { ok: false, code: CODES.BAD_TRANSITION };
    const next = Object.freeze({
      ...record,
      state: failed ? STATES.FAILED : STATES.COMPLETED,
      outcome: outcome === undefined ? null : outcome,
      updatedAt: Date.now(),
    });
    try {
      useTx(() => update(next));
    } catch (_) {
      return { ok: false, code: CODES.PERSIST_FAILED };
    }
    return { ok: true, state: next.state };
  }

  function pendingRecords() {
    if (!durable) return [...memory.values()].filter((record) => record.state === STATES.PENDING);
    const db = liveDb();
    if (!db) return [];
    const records = [];
    for (const row of db.prepare(`SELECT * FROM ${TABLE} WHERE state = ?`).all(STATES.PENDING)) {
      try {
        records.push(toRecord(row));
      } catch (_) {
        // One unreadable row must not take down recovery of the others.
      }
    }
    return records;
  }

  /**
   * Restart recovery: every operation still pending. The caller verifies
   * each against the outside world; this function completes nothing.
   */
  function reconcile() {
    return pendingRecords().map((record) => Object.freeze({
      operationId: record.operationId,
      runId: record.runId,
      workspaceId: record.workspaceId,
      state: 'unknown',
    }));
  }

  /**
   * Plan a late outcome. When the run is still open the outcome belongs on
   * it; when closed, the run is never mutated — the plan opens a linked
   * run carrying the outcome as a new assessment instead.
   */
  function lateOutcome({ operationId, outcome, runClosed } = {}) {
    const record = tryFind(operationId);
    if (!record) return { ok: false, code: CODES.UNKNOWN_OPERATION };
    if (!runClosed) {
      return { ok: true, action: 'append-outcome', runId: record.runId, outcome: outcome === undefined ? null : outcome };
    }
    return {
      ok: true,
      action: 'open-linked-run',
      parentRunId: record.runId,
      workspaceId: record.workspaceId,
      outcome: outcome === undefined ? null : outcome,
    };
  }

  return Object.freeze({ begin, claim, complete, reconcile, lateOutcome });
}

module.exports = Object.freeze({ createOperationLedger, STATES, CODES, TABLE });
