'use strict';

const { spawnSync } = require('node:child_process');
const {
  describeSqliteLoadFailure,
  loadSqliteDriver,
} = require('../lib/sqlite-availability');

const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const INSTALL_ARGS = ['ci', '--include=optional', '--no-audit', '--no-fund'];
const REBUILD_ARGS = ['rebuild', 'better-sqlite3', '--no-audit', '--no-fund'];

function commandLabel(args) {
  return [NPM_COMMAND, ...args].join(' ');
}

function runNpm(args) {
  console.log(`\n$ ${commandLabel(args)}`);
  const result = spawnSync(NPM_COMMAND, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${commandLabel(args)} exited with code ${result.status ?? 'unknown'}`);
  }
}

function verifySqlite() {
  const { Database, loadError } = loadSqliteDriver();
  if (!Database) {
    const failure = describeSqliteLoadFailure(loadError);
    console.error(`better-sqlite3 unavailable (${failure.kind}).\n${failure.hint}`);
    return false;
  }

  let db;
  try {
    db = new Database(':memory:');
    const row = db.prepare('SELECT sqlite_version() AS version').get();
    if (!row || typeof row.version !== 'string' || !row.version) {
      throw new Error('SQLite returned no version from an in-memory probe');
    }
    console.log(`better-sqlite3 ok (SQLite ${row.version}, Node ${process.version})`);
    return true;
  } catch (error) {
    const failure = describeSqliteLoadFailure(error);
    console.error(`better-sqlite3 verification failed (${failure.kind}).\n${failure.hint}`);
    return false;
  } finally {
    if (db) db.close();
  }
}

function setupSqlite() {
  if (verifySqlite()) return 0;

  console.log('Installing locked dependencies with the CI-compatible SQLite setup.');
  runNpm(INSTALL_ARGS);
  if (verifySqlite()) return 0;

  console.log('The dependency is present but did not load; rebuilding its native binary.');
  runNpm(REBUILD_ARGS);
  if (verifySqlite()) return 0;

  console.error('SQLite setup did not produce a loadable better-sqlite3 binary.');
  return 1;
}

function main() {
  try {
    return setupSqlite();
  } catch (error) {
    console.error(`SQLite setup failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  INSTALL_ARGS,
  REBUILD_ARGS,
  classifyLoadFailure: describeSqliteLoadFailure,
  commandLabel,
  setupSqlite,
  verifySqlite,
};
