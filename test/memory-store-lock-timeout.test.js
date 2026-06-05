'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MemoryStore = require('../lib/memory-store');
const { DEFAULT_BUSY_RETRY } = require('../lib/memory-store-utils');

function getDbPath(label) {
  return path.join(
    os.tmpdir(),
    `axiom-pr-s3b-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
  );
}

function cleanupDb(p) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      if (p && fs.existsSync(p + suffix)) fs.unlinkSync(p + suffix);
    } catch (_) {
      // best-effort cleanup
    }
  }
}

function makeBusyError() {
  const err = new Error('SQLITE_BUSY: database is locked');
  err.code = 'SQLITE_BUSY';
  return err;
}

describe('PR-S3B memory lock timeout + SQLite busy retry', () => {
  test('SQLITE_BUSY retry succeeds within bounded attempts', () => {
    const dbPath = getDbPath('retry-success');
    try {
      const store = new MemoryStore({ useSQLite: true, dbPath });
      // Inject controlled SQLITE_BUSY on the first 2 insertEvent.run calls,
      // then succeed. With maxAttempts=3 the bounded retry should recover.
      const realInsertEvent = store._stmts.insertEvent.run;
      let callCount = 0;
      store._stmts.insertEvent.run = function () {
        callCount++;
        if (callCount <= 2) throw makeBusyError();
        return realInsertEvent.apply(this, arguments);
      };
      const res = store.store({ content: { data: 'x' } });
      store._stmts.insertEvent.run = realInsertEvent;
      assert.strictEqual(res.ok, true,
        `expected ok, got error: ${JSON.stringify(res.error)}`);
      assert.ok(res.memory && res.memory.memoryId,
        'expected returned memory record');
      assert.strictEqual(callCount, 3,
        'expected 2 BUSY attempts + 1 success within maxAttempts=3');
      assert.strictEqual(res.error, undefined,
        'success path must not surface PERSISTENCE_ERROR');
      store.close();
    } finally { cleanupDb(dbPath); }
  });

  test('retry exhaustion fails cleanly with PERSISTENCE_ERROR', () => {
    const dbPath = getDbPath('retry-exhaust');
    try {
      const store = new MemoryStore({ useSQLite: true, dbPath });
      // Force every insertEvent.run to throw SQLITE_BUSY. With maxAttempts=3
      // the bounded retry must exhaust and surface a structured error.
      const realInsertEvent = store._stmts.insertEvent.run;
      let callCount = 0;
      store._stmts.insertEvent.run = function () {
        callCount++;
        throw makeBusyError();
      };
      const res = store.store({ content: { data: 'always-busy' } });
      store._stmts.insertEvent.run = realInsertEvent;
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error.code, 'PERSISTENCE_ERROR');
      assert.strictEqual(res.error.operation, 'store');
      assert.ok(res.error.message && res.error.message.includes('SQLITE_BUSY'),
        `expected message to include SQLITE_BUSY, got: ${res.error.message}`);
      assert.strictEqual(callCount, 3,
        'expected exactly 3 retry attempts before exhaustion (maxAttempts)');
      // Public error contract is preserved: only code + operation + message.
      // Bounded retry metadata stays on the underlying Error and is not
      // bubbled into the public response.
      assert.strictEqual(res.error.busyRetries, undefined,
        'busyRetries must not leak into the public error contract');
      store.close();
    } finally { cleanupDb(dbPath); }
  });

  test('busy_timeout PRAGMA is set to bounded value (250ms)', () => {
    const dbPath = getDbPath('pragma');
    try {
      const store = new MemoryStore({ useSQLite: true, dbPath });
      const result = store._db.pragma('busy_timeout');
      const value = (typeof result === 'object' && result !== null)
        ? (Array.isArray(result) ? (result[0].busy_timeout ?? result[0].timeout) : (result.busy_timeout ?? result.timeout))
        : result;
      assert.strictEqual(value, DEFAULT_BUSY_RETRY.busyTimeoutMs);
      assert.strictEqual(value, 250,
        'expected busy_timeout=250ms (PR-S3B default)');
      // Override path: pass busyRetry config
      store.close();
      const store2 = new MemoryStore({
        useSQLite: true,
        dbPath: getDbPath('pragma-override'),
        busyRetry: { busyTimeoutMs: 500 },
      });
      const result2 = store2._db.pragma('busy_timeout');
      const value2 = (typeof result2 === 'object' && result2 !== null)
        ? (Array.isArray(result2) ? (result2[0].busy_timeout ?? result2[0].timeout) : (result2.busy_timeout ?? result2.timeout))
        : result2;
      assert.strictEqual(value2, 500,
        'expected busy_timeout=500ms via opts.busyRetry override');
      store2.close();
      cleanupDb(getDbPath('pragma-override'));
    } finally { cleanupDb(dbPath); }
  });

  test('transaction rollback leaves no partial write on lock failure', () => {
    const dbPath = getDbPath('rollback-busy');
    try {
      const store = new MemoryStore({ useSQLite: true, dbPath });
      // Force every insertEvent.run to throw SQLITE_BUSY inside the
      // transaction. Retry must exhaust, and the store's own rollback
      // path must leave the DB clean (no memory row, no event).
      const realInsertEvent = store._stmts.insertEvent.run;
      store._stmts.insertEvent.run = function () {
        throw makeBusyError();
      };
      const res = store.store({ content: { data: 'will-rollback' } });
      store._stmts.insertEvent.run = realInsertEvent;
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error.code, 'PERSISTENCE_ERROR');
      assert.strictEqual(res.error.operation, 'store');
      // Close and reload to verify DB has no partial state
      store.close();
      const store2 = new MemoryStore({ useSQLite: true, dbPath });
      const listRes = store2.list();
      assert.strictEqual(listRes.total, 0,
        'expected no memory rows after rollback');
      const timeline = store2.timeline();
      assert.strictEqual(timeline.total, 0,
        'expected no events after rollback');
      store2.close();
    } finally { cleanupDb(dbPath); }
  });
});
