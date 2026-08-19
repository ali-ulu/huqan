'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-package-import-runner.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('MS: importPackage orchestration is delegated to the package import runner', () => {
  assert.ok(
    storeSource.includes("const { runImportPackage } = require('./memory-package-import-runner');"),
    'lib/memory-store.js imports runImportPackage',
  );
  const methodMatch = storeSource.match(/importPackage\(pkg, opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(methodMatch, 'importPackage method still exists');
  const body = methodMatch[0];
  assert.match(
    body,
    /importPackage\(pkg, opts = \{\}\) \{\s*return runImportPackage\(this\._importPackageStoreApi\(\), pkg, opts\);/,
    'importPackage is a one-line delegation',
  );

  const stripped = body.replace(/return runImportPackage\([\s\S]*?\);/, '');
  for (const banned of [
    'validateMemoryPackage',
    'validateMemoryRecord',
    'normalizeMemoryRecord',
    'ImportConflictError',
    'this._db',
    'this._stmts',
    'this._memories',
    'this._events',
    'this._links',
    '_withTransaction',
  ]) {
    assert.ok(!stripped.includes(banned), `importPackage wrapper must not contain ${banned}`);
  }

  const apiMatch = storeSource.match(/_importPackageStoreApi\(\) \{[\s\S]*?\n  \}/);
  assert.ok(apiMatch, '_importPackageStoreApi wrapper exists');
  assert.ok(!apiMatch[0].includes('runImportPackage'), 'store API is not the delegation site');
});

test('MS: pinned call sites — importPackage delegation remains fail-closed', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-package-import-runner'\)/g) || []).length, 1, 'delegate require appears once');
  assert.equal((storeSource.match(/runImportPackage\(/g) || []).length, 1, 'runImportPackage has one call site');
  assert.equal((storeSource.match(/_importPackageStoreApi\(\)/g) || []).length, 2, 'API factory has one definition plus one call site');
  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this/store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back into memory-store');
  for (const banned of [
    '_db',
    '_stmts',
    '_memories',
    '_events',
    '_links',
    '_withTransaction',
    'Database',
    'snapshotInMemoryState',
    'restoreInMemoryState',
  ]) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch store internals (${banned})`);
  }

  const persistIndex = delegateCode.indexOf('storeApi.persistMemory(');
  const rememberIndex = delegateCode.indexOf('storeApi.rememberMemory(');
  const importEventsIndex = delegateCode.indexOf('storeApi.importEvents(');
  const importLinksIndex = delegateCode.indexOf('storeApi.importLinks(');
  assert.ok(persistIndex >= 0, 'delegate persists each memory through store API');
  assert.ok(rememberIndex > persistIndex, 'in-memory memory mutation occurs after persistence');
  assert.ok(importEventsIndex > rememberIndex, 'event admission occurs after memory admission');
  assert.ok(importLinksIndex > importEventsIndex, 'link admission occurs after event admission');
});
