'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const facade = require('../lib/memory-store-utils');
const persistencePaths = require('../lib/memory-persistence-paths');
const busyRetry = require('../lib/sqlite-busy-retry');

test('memory-store-utils facade preserves extracted persistence-path contract', () => {
  for (const key of [
    'resolveDbPath',
    'siblingPersistencePath',
    'assertDistinctPersistencePaths',
    'derivePersistenceLayout',
    'resolveContainedPath',
  ]) {
    assert.equal(facade[key], persistencePaths[key], key);
  }

  assert.equal(
    persistencePaths.siblingPersistencePath('/tmp/memory', '.db'),
    '/tmp/memory.db',
  );
  assert.equal(
    persistencePaths.siblingPersistencePath('/tmp/memory.json', '.db'),
    '/tmp/memory.db',
  );
});

test('memory-store-utils facade preserves extracted sqlite busy-retry contract', () => {
  for (const key of [
    'DEFAULT_BUSY_RETRY',
    'resolveBusyRetryConfig',
    'isSqliteBusyError',
    'runWithBusyRetry',
    'syncSleep',
  ]) {
    assert.equal(facade[key], busyRetry[key], key);
  }

  assert.equal(busyRetry.isSqliteBusyError({ code: 'SQLITE_BUSY' }), true);
  assert.equal(busyRetry.isSqliteBusyError({ code: 'SQLITE_LOCKED' }), true);
  assert.equal(busyRetry.isSqliteBusyError(new Error('database is locked')), true);
  assert.equal(busyRetry.isSqliteBusyError(new Error('other failure')), false);
});
