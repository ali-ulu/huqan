const crypto = require('crypto');
const { applyStorageSchema } = require('./lib/storage/schema');
const { loadSqliteDriver, sqliteUnavailableError } = require('./lib/sqlite-availability');
const { applySqliteDurability } = require('./lib/sqlite-durability');
const { normalizeWorkspaceId } = require('./lib/workspace-id');
const toolApprovalMethods = require('./lib/storage/tool-approval-methods');
const runStateMethods = require('./lib/storage/run-state-methods');
const { prepareStorageStatements } = require('./lib/storage/statements');
const { resolveDbPath } = require('./lib/storage/db-path');
const { safeParse } = require('./lib/storage/run-state-keys');

// The load error is retained (not discarded as before) so the throw site can
// tell "not installed" from "installed but built for a different Node ABI" —
// two failures with different fixes that used to look identical to the user.
const { Database, loadError: sqliteLoadError } = loadSqliteDriver();

// Rows pulled per keyset page when recovering expired execution leases (#426).
const RECOVERY_PAGE_SIZE = 500;

const APPROVAL_KEY_SEPARATOR = '\u001f';

function approvalWorkspaceId(record = {}) {
  return normalizeWorkspaceId(
    record.workspaceId
      ?? record.context?.workspaceId
      ?? record.context?.snapshot?.workspaceId,
  );
}

function scopedApprovalKey(approvalKey, workspaceId) {
  const key = String(approvalKey || '');
  const prefix = `${workspaceId}${APPROVAL_KEY_SEPARATOR}`;
  return key.startsWith(prefix) ? key : `${prefix}${key}`;
}

class HuqanStorage {
  constructor(opts = {}) {
    this.kernel = opts.kernel;
    this.dbPath = resolveDbPath(opts, this.kernel);
    if (!Database) {
      throw sqliteUnavailableError('better-sqlite3 is required for v3 storage.', sqliteLoadError);
    }
    this.db = new Database(this.dbPath);
    try { // Agent checkpoints may resume from the prior checkpoint after a lost final fsync.
      applySqliteDurability(this.db, 'RESUMABLE');
      this._init();
    } catch (error) {
      try { this.db.close(); } catch (_) {}
      throw error;
    }
  }

  _init() {
    applyStorageSchema(this.db);

    this._stmts = prepareStorageStatements(this.db);
  }

  _now() {
    return Date.now();
  }

  // `id` is a PRIMARY KEY on every table here, and a bare `${prefix}-${now}`
  // collides for any two records created within the same millisecond (#412).
  // For tool_approvals that is not absorbed by the upsert: ON CONFLICT is
  // declared on approval_key, so two *different* approvals landing on the same
  // id raise SQLITE_CONSTRAINT_PRIMARYKEY instead. Keep the timestamp prefix so
  // ids stay roughly time-ordered, and append randomness for uniqueness --
  // the same shape agent.js already uses for its run ids.
  _newId(prefix) {
    return `${prefix}-${this._now()}-${crypto.randomBytes(6).toString('hex')}`;
  }

  // Synchronous only: all writes must finish before SQLite commits.
  withTransaction(write) {
    return this.db.transaction(write)();
  }

  _hydrateToolApproval(row) {
    return {
      ...row,
      context: safeParse(row.context_json, {}),
      policy: safeParse(row.policy_json, {}),
    };
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch (_) {}
    }
    this.db = null;
    this._stmts = null;
  }

  /**
   * Reopens the SQLite connection after restore replaced the backing memory.db.
   * The dbPath was resolved in the constructor and durability mode is fixed, so
   * the handle and statements can be rebuilt without re-running path
   * resolution. Callers (CLI restore, #1848) close before the file replacement
   * because Windows refuses to rename over an open database file (EPERM).
   */
  reopen() {
    if (this.db) {
      try { this.db.close(); } catch (_) {}
    }
    this.db = new Database(this.dbPath);
    applySqliteDurability(this.db, 'RESUMABLE');
    this._init();
  }
}

// Checkpoint, goal-memory and run records live in lib/storage/run-state-methods.js
// (#2165); they keep the non-enumerable descriptor they had as class methods.
for (const [name, method] of Object.entries(runStateMethods)) {
  Object.defineProperty(HuqanStorage.prototype, name, { value: method, writable: true, configurable: true, enumerable: false });
}
Object.assign(HuqanStorage.prototype, toolApprovalMethods);

module.exports = HuqanStorage;
