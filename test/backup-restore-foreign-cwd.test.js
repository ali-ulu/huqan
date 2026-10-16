'use strict';

// #3633: `huqan backup`/`restore` run the SQLite online backup and the restore
// source validation in a child `node -e` process. That child resolves
// `require('better-sqlite3')` from its cwd, so a globally installed CLI (which
// always runs outside the install dir) failed with "Cannot find module
// 'better-sqlite3'". The fix pins the child cwd to the install root; this test
// drives a real createBackup + restoreBackup from a foreign cwd and would fail
// on the pre-fix code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBackup, restoreBackup } = require('../backupRestore');
const { loadSqliteDriver } = require('../lib/sqlite-availability');
const { applyStorageSchema } = require('../lib/storage/schema');

test('backup and restore resolve better-sqlite3 from the install root, not the operator cwd', (t) => {
  const { Database, loadError } = loadSqliteDriver();
  if (!Database) return t.skip(`better-sqlite3 unavailable: ${loadError && loadError.message}`);

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-backup-foreign-'));
  const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-foreign-cwd-'));
  const opts = {
    rootDir,
    memoryPath: path.join(rootDir, 'memory.json'),
    dbPath: path.join(rootDir, 'memory.db'),
    backupBaseDir: path.join(rootDir, 'backups'),
  };
  fs.writeFileSync(opts.memoryPath, '{"fact":"before"}');

  const db = new Database(opts.dbPath);
  try {
    applyStorageSchema(db);
  } finally {
    db.close();
  }

  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(foreignCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  process.chdir(foreignCwd);
  assert.notEqual(process.cwd(), rootDir, 'the CLI must run outside the install root for this to regress');

  const backup = createBackup({ ...opts, backupId: 'foreign-source' });
  assert.ok(backup.manifest.files.includes('memory.db'), 'memory.db must be backed up from the foreign cwd');

  fs.writeFileSync(opts.memoryPath, '{"fact":"after"}');
  const restored = restoreBackup({ ...opts, backupDir: backup.backupDir });
  assert.deepEqual(restored.verification, { persistence: true, schema: true, graphIntegrity: true, receipt: true });
  assert.equal(fs.readFileSync(opts.memoryPath, 'utf8'), '{"fact":"before"}');
});
