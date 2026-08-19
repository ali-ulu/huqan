'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-tombstone.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('MS: tombstone logic is delegated to lib/memory-tombstone.js', () => {
  assert.ok(
    storeSource.includes("const { runTombstone } = require('./memory-tombstone');"),
    'lib/memory-store.js imports runTombstone',
  );
  const methodMatch = storeSource.match(/tombstone\(memoryId, opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(methodMatch, 'tombstone method still exists');
  const body = methodMatch[0];
  assert.match(
    body,
    /tombstone\(memoryId, opts = \{\}\) \{\s*return runTombstone\(this\._tombstoneStoreApi\(\), memoryId, opts\);/,
    'tombstone is a one-line delegation',
  );

  const stripped = body.replace(/return runTombstone\([\s\S]*?\);/, '');
  for (const banned of [
    'validateMemoryEvent',
    'generateEventId',
    'makeProvenance',
    'MEMORY_SCHEMA_VERSIONS',
    'this._events',
    'this._stmts',
    '_withTransaction',
  ]) {
    assert.ok(!stripped.includes(banned), `tombstone wrapper must not contain ${banned}`);
  }

  const apiMatch = storeSource.match(/_tombstoneStoreApi\(\) \{[\s\S]*?\n  \}/);
  assert.ok(apiMatch, '_tombstoneStoreApi wrapper exists');
  assert.ok(!apiMatch[0].includes('runTombstone'), 'store API is not the delegation site');
});

test('MS: pinned call sites — tombstone delegation remains fail-closed', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-tombstone'\)/g) || []).length, 1, 'delegate require appears once');
  assert.equal((storeSource.match(/runTombstone\(/g) || []).length, 1, 'runTombstone has one call site');
  assert.equal((storeSource.match(/_tombstoneStoreApi\(\)/g) || []).length, 2, 'API factory has one definition plus one call site');
  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this/store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back into memory-store');
  for (const banned of [
    '_db',
    '_stmts',
    '_events',
    '_withTransaction',
    'Database',
    'snapshotInMemoryState',
    'restoreInMemoryState',
  ]) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch store internals (${banned})`);
  }

  const persistIndex = delegateCode.indexOf('storeApi.persist(');
  const markDeletedIndex = delegateCode.indexOf('storeApi.markDeleted(');
  const appendEventIndex = delegateCode.indexOf('storeApi.appendEvent(');
  assert.ok(persistIndex >= 0, 'delegate persists through store API');
  assert.ok(markDeletedIndex > persistIndex, 'in-memory record mutation occurs after persistence');
  assert.ok(appendEventIndex > persistIndex, 'event append occurs after persistence');
});
