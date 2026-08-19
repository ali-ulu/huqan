'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store-write.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('MS: store record construction is delegated to the write runner', () => {
  assert.ok(
    storeSource.includes("const { runStore } = require('./memory-store-write');"),
    'lib/memory-store.js imports runStore',
  );
  const methodMatch = storeSource.match(/\n  store\(input = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(methodMatch, 'store method still exists');
  const body = methodMatch[0];
  assert.match(
    body,
    /\n  store\(input = \{\}\) \{\s*\n    return runStore\(this\._storeStoreApi\(\), input\);\s*\n  \}/,
    'store is a one-line delegation',
  );

  const stripped = body.replace(/return runStore\([\s\S]*?\);/, '');
  for (const banned of [
    'validateMemoryRecord',
    'normalizeMemoryRecord',
    'generateMemoryId',
    'generateEventId',
    'this._db',
    'this._stmts',
    'this._memories',
    'this._events',
    '_withTransaction',
  ]) {
    assert.ok(!stripped.includes(banned), `store wrapper must not contain ${banned}`);
  }

  const apiMatch = storeSource.match(/\n  _storeStoreApi\(\) \{[\s\S]*?\n  \}/);
  assert.ok(apiMatch, '_storeStoreApi wrapper exists');
  assert.ok(!apiMatch[0].includes('runStore'), 'store API is not the delegation site');
});

test('MS: pinned write delegate has no receiver cycle and persists before mutation', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-store-write'\)/g) || []).length, 1, 'delegate require appears once');
  assert.equal((storeSource.match(/runStore\(/g) || []).length, 1, 'runStore has one call site');
  assert.equal((storeSource.match(/_storeStoreApi\(\)/g) || []).length, 2, 'API factory has one definition plus one call site');
  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this/store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back into memory-store');

  for (const banned of [
    '_db',
    '_stmts',
    '_memories',
    '_events',
    '_withTransaction',
    'Database',
    'snapshotInMemoryState',
    'restoreInMemoryState',
  ]) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch store internals (${banned})`);
  }

  const persistIndex = delegateCode.indexOf('storeApi.persist(');
  const rememberIndex = delegateCode.indexOf('storeApi.remember(');
  assert.ok(persistIndex >= 0, 'delegate persists through store API');
  assert.ok(rememberIndex > persistIndex, 'in-memory mutation occurs after persistence');
});
