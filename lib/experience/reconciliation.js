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
 */
function createOperationLedger({ store } = {}) {
  const memory = new Map();
  const useTx = store && typeof store.withTransaction === 'function'
    ? (fn) => store.withTransaction(fn)
    : (fn) => fn();
  const db = store && store.db ? store.db : null;
  if (db) ensureTable(db);

  function putMemory(record) {
    memory.set(record.operationId, record);
  }

  function persistInsert(record) {
    if (!db) return;
    db.prepare(`INSERT INTO ${TABLE}`
      + ' (operation_id, run_id, workspace_id, intent_hash, intent_body, state, outcome_body, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.operationId, record.runId, record.workspaceId,
        sha256(stableJson(record.intent)), stableJson(record.intent),
        record.state, record.outcome == null ? null : stableJson(record.outcome),
        record.updatedAt);
  }

  function persistState(operationId, state, outcome) {
    if (!db) return;
    db.prepare(`UPDATE ${TABLE} SET state = ?, outcome_body = ?, updated_at = ? WHERE operation_id = ?`)
      .run(state, outcome == null ? null : stableJson(outcome), Date.now(), operationId);
  }

  /**
   * Record intent before performing any external effect. The effect must
   * only happen when this returns `ok: true`.
   */
  function begin({ operationId, runId, workspaceId, intent } = {}) {
    if (!nonEmptyString(operationId) || !nonEmptyString(runId)) {
      return { ok: false, code: 'invalid_operation' };
    }
    const ws = nonEmptyString(workspaceId) || 'default';
    const existing = memory.get(operationId);
    if (existing) {
      if (existing.runId === runId && stableJson(existing.intent) === stableJson(intent || null)) {
        return { ok: true, duplicate: true, state: existing.state };
      }
      return { ok: false, code: CODES.OPERATION_CONFLICT };
    }
    const record = Object.freeze({
      operationId, runId, workspaceId: ws,
      intent: intent === undefined ? null : intent,
      state: STATES.PENDING, outcome: null, updatedAt: Date.now(),
    });
    try {
      useTx(() => {
        persistInsert(record);
        putMemory(record);
      });
    } catch (err) {
      // A UNIQUE violation means a concurrent writer won the race: re-read
      // the winner rather than reporting a store failure.
      if (err && /UNIQUE constraint failed/i.test(String(err.message))) {
        const winner = memory.get(operationId) || readRow(operationId);
        if (winner) {
          if (winner.runId === runId && stableJson(winner.intent) === stableJson(intent || null)) {
            return { ok: true, duplicate: true, state: winner.state };
          }
          return { ok: false, code: CODES.OPERATION_CONFLICT };
        }
      }
      return { ok: false, code: CODES.PERSIST_FAILED };
    }
    return { ok: true, duplicate: false, state: STATES.PENDING };
  }

  function readRow(operationId) {
    if (!db) return null;
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE operation_id = ?`).get(operationId);
    return row ? toRecord(row) : null;
  }

  /** Replay-safe read: returns the recorded outcome, never performs work. */
  function claim(operationId) {
    const record = memory.get(operationId) || readRow(operationId);
    if (!record) return { ok: false, code: CODES.UNKNOWN_OPERATION };
    if (record.state === STATES.PENDING) return { ok: true, state: record.state, outcome: null };
    return { ok: true, state: record.state, outcome: record.outcome };
  }

  /** Record the external effect's outcome. Pending → completed/failed only. */
  function complete({ operationId, outcome, failed = false } = {}) {
    const record = memory.get(operationId);
    if (!record) return { ok: false, code: CODES.UNKNOWN_OPERATION };
    if (record.state !== STATES.PENDING) return { ok: false, code: CODES.BAD_TRANSITION };
    const next = Object.freeze({
      ...record,
      state: failed ? STATES.FAILED : STATES.COMPLETED,
      outcome: outcome === undefined ? null : outcome,
      updatedAt: Date.now(),
    });
    try {
      useTx(() => {
        persistState(operationId, next.state, next.outcome);
        putMemory(next);
      });
    } catch (_) {
      return { ok: false, code: CODES.PERSIST_FAILED };
    }
    return { ok: true, state: next.state };
  }

  /**
   * Restart recovery: every operation still pending. The caller verifies
   * each against the outside world; this function completes nothing.
   */
  function reconcile() {
    return [...memory.values()]
      .filter((record) => record.state === STATES.PENDING)
      .map((record) => Object.freeze({
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
    const record = memory.get(operationId);
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

  // Rebuild the cache from the store so acknowledged intents survive a
  // restart. Rows are single-statement transactional writes, so each row
  // is either pending or completed — never torn.
  if (db) {
    const rows = db.prepare(`SELECT * FROM ${TABLE}`).all();
    for (const row of rows) {
      try {
        putMemory(toRecord(row));
      } catch (_) {
        // One unreadable row must not take down the rebuild.
      }
    }
  }

  return Object.freeze({ begin, claim, complete, reconcile, lateOutcome });
}

module.exports = Object.freeze({ createOperationLedger, STATES, CODES, TABLE });
