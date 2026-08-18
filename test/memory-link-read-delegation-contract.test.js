'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-link-read.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

const methods = [
  ['getLinks', 'readLinks', 'getLinks(memoryId)'],
  ['findLinks', 'readFindLinks', 'findLinks(memoryId, opts = {})'],
  ['findLinkedMemories', 'readFindLinkedMemories', 'findLinkedMemories(memoryId, opts = {})'],
  ['getBacklinks', 'readBacklinks', 'getBacklinks(memoryId, opts = {})'],
  ['traverseLinks', 'readTraverseLinks', 'traverseLinks(memoryId, opts = {})'],
  ['queryLinks', 'readQueryLinks', 'queryLinks(opts = {})'],
  ['linksForMemory', 'readLinksForMemory', 'linksForMemory(memoryId, opts = {})'],
];

test('MS: link-read logic is delegated to lib/memory-link-read.js', () => {
  assert.ok(
    storeSource.includes("} = require('./memory-link-read');"),
    'lib/memory-store.js imports memory-link-read.js',
  );
  assert.ok(
    storeSource.includes('const {\n  getLinks: readLinks,'),
    'link-read imports use named aliases',
  );

  for (const [method, delegate, signature] of methods) {
    const methodMatch = storeSource.match(new RegExp(`${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[\\s\\S]*?\\n  \\}`));
    assert.ok(methodMatch, `${method} method still exists`);
    const body = methodMatch[0];
    assert.match(body, new RegExp(`return ${delegate}\\(this\\._linkReadContext\\(\\)`), `${method} is a context delegation`);
    const stripped = body.replace(/return [a-zA-Z]+\(this\._linkReadContext\(\),[\s\S]*?\);/, '');
    for (const banned of ['validateMemory', 'normalizeMemory', 'this._links', 'this._memories', 'this._findMemory', 'this._isActiveRecord', 'sortByLinkSignature']) {
      assert.ok(!stripped.includes(banned), `${method} wrapper must not contain ${banned}`);
    }
  }
});

test('MS: pinned call sites — seven link-read delegations', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-link-read'\)/g) || []).length, 1, 'delegate require appears once');
  for (const [, delegate] of methods) {
    assert.equal((storeSource.match(new RegExp(`\\b${delegate}\\(`, 'g')) || []).length, 1, `${delegate} has one call site`);
  }
  assert.equal((storeSource.match(/_linkReadContext\(\)/g) || []).length, 8, 'context factory has one definition plus seven call sites');
  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this/store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back into memory-store');
  for (const banned of ['_db', '_stmts', '_withTransaction', 'Database', 'persist(', 'insertMemory', 'updateMemory']) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch mutation internals (${banned})`);
  }
  assert.equal((delegateCode.match(/context\.links\.push/g) || []).length, 0, 'delegate never mutates context.links');
  assert.equal((delegateCode.match(/context\.links\s*=/g) || []).length, 0, 'delegate never reassigns context.links');
});
