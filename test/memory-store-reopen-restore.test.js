'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MemoryStore = require('../lib/memory-store');
const Database = require('better-sqlite3');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reopen-restore-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // Ignore EPERM locks on Windows
  }
});

function getDbPath(name) {
  return path.join(tempDir, `${name}.db`);
}

// The issue's exact reproduction, expressed as a test: after a restore copies an
// earlier backup over the live database, a reopened MemoryStore must serve only
// the records the restored database actually contains.
describe('MemoryStore reopen after restore (#1864)', () => {

  it('reopened store matches a freshly opened one after a backup is restored', () => {
    const dbPath = getDbPath('restore-repro');
    const backupPath = getDbPath('restore-repro-backup');

    const store = new MemoryStore({ useSQLite: true, dbPath });
    store.store({ content: 'before backup' });
    store.close();

    fs.copyFileSync(dbPath, backupPath); // snapshot with 1 record

    // Reopen and add a record that lives only until the restore.
    store.reopen();
    store.store({ content: 'after backup' });
    assert.strictEqual(store.list().total, 2, 'two records before restore');
    store.close();

    // Restore: overwrite the live DB with the 1-record backup, then reopen.
    fs.copyFileSync(backupPath, dbPath);
    store.reopen();

    const fresh = new MemoryStore({ useSQLite: true, dbPath });
    assert.strictEqual(store.list().total, fresh.list().total, 'same total after restore');
    assert.strictEqual(store.list().total, 1, 'only the pre-backup record survives');
    assert.strictEqual(store.list().memories[0].content, 'before backup');
    assert.strictEqual(store._events.length, fresh._events.length, 'event count matches fresh');
    assert.strictEqual(store._links.length, fresh._links.length, 'link count matches fresh');

    fresh.close();
    store.close();
    assert.ok(!store.list().memories.some((m) => m.content === 'after backup'),
      'the post-backup record is gone from the reopened store');
  });

  it('repeated close/reopen does not multiply event or link counts', () => {
    const dbPath = getDbPath('repeat-reopen');
    const store = new MemoryStore({ useSQLite: true, dbPath });
    store.store({ content: 'fact', workspaceId: 'ws' });
    store.close();

    const baseline = new MemoryStore({ useSQLite: true, dbPath });
    const expectedEvents = baseline._events.length;
    const expectedLinks = baseline._links.length;
    baseline.close();

    store.reopen();
    store.reopen();
    store.reopen();
    assert.strictEqual(store.list({ workspaceId: 'ws' }).total, 1, 'still one record after 3 reopens');
    assert.strictEqual(store._events.length, expectedEvents, 'events not multiplied');
    assert.strictEqual(store._links.length, expectedLinks, 'links not multiplied');
    store.close();
  });

  it('reopen resets the corrupt-rows journal as well', () => {
    const dbPath = getDbPath('corrupt-reset');
    const store = new MemoryStore({ useSQLite: true, dbPath });
    store.store({ content: 'ok' });
    store.close();
    store.reopen();
    assert.strictEqual(store.corruptRows.length, 0, 'corruptRows starts empty');
    store.close();
  });

});
