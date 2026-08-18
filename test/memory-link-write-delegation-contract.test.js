'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-link-write.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('MS: link-write logic is delegated to lib/memory-link-write.js', () => {
  assert.ok(
    storeSource.includes("const { runLinkMemories } = require('./memory-link-write');"),
    'lib/memory-store.js imports runLinkMemories',
  );
  const methodMatch = storeSource.match(/linkMemories\(opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(methodMatch, 'linkMemories method still exists');
  const body = methodMatch[0];
  assert.match(
    body,
    /linkMemories\(opts = \{\}\) \{\s*return runLinkMemories\(this\._linkWriteStoreApi\(\), opts\);/,
    'linkMemories is a one-line delegation',
  );

  const stripped = body.replace(/return runLinkMemories\([\s\S]*?\);/, '');
  for (const banned of [
    'validateMemoryLink',
    'validateMemoryEvent',
    'generateDeterministicLinkId',
    'generateEventId',
    'makeProvenance',
    'MEMORY_SCHEMA_VERSIONS',
    'this._links',
    'this._events',
    'this._stmts',
    '_withTransaction',
  ]) {
    assert.ok(!stripped.includes(banned), `linkMemories wrapper must not contain ${banned}`);
  }

  const apiMatch = storeSource.match(/_linkWriteStoreApi\(\) \{[\s\S]*?\n  \}/);
  assert.ok(apiMatch, '_linkWriteStoreApi wrapper exists');
  assert.ok(!apiMatch[0].includes('runLinkMemories'), 'store API is not the delegation site');
});

test('MS: pinned call sites — link-write delegation', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-link-write'\)/g) || []).length, 1, 'delegate require appears once');
  assert.equal((storeSource.match(/runLinkMemories\(/g) || []).length, 1, 'runLinkMemories has one call site');
  assert.equal((storeSource.match(/_linkWriteStoreApi\(\)/g) || []).length, 2, 'API factory has one definition plus one call site');
  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this/store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back into memory-store');
  for (const banned of ['_db', '_stmts', '_links', '_events', '_withTransaction', 'Database', 'snapshotInMemoryState', 'restoreInMemoryState']) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch store internals (${banned})`);
  }

  const persistIndex = delegateCode.indexOf('storeApi.persist(');
  const appendLinkIndex = delegateCode.indexOf('storeApi.appendLink(');
  const appendEventIndex = delegateCode.indexOf('storeApi.appendEvent(');
  assert.ok(persistIndex >= 0, 'delegate persists through store API');
  assert.ok(appendLinkIndex > persistIndex, 'link append occurs after persistence');
  assert.ok(appendEventIndex > persistIndex, 'event append occurs after persistence');
});
