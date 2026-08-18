// Pin-locked contract: the supersede decision/payload logic lives in
// lib/memory-supersede.js (MS: #328), and MemoryStore.supersede is a one-line
// delegation through _supersedeStoreApi(). The pinned call-site counts below
// MUST be updated together with any structural change to lib/memory-store.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-supersede.js');
const DELEGATE_REQUIRE_REGEX = /require\('\.\/memory-supersede'\)/;

const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');

test('MS: supersede logic is delegated to lib/memory-supersede.js (only ownership moved)', () => {
  assert.ok(
    storeSource.includes("const { runSupersede } = require('./memory-supersede');"),
    'lib/memory-store.js imports runSupersede',
  );

  const match = storeSource.match(/supersede\(oldMemoryId, newContent, opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'supersede method still exists');
  const body = match[0];
  assert.ok(
    /supersede\(oldMemoryId, newContent, opts = \{\}\) \{\s*return runSupersede\(/.test(body),
    'supersede is a one-line delegation to runSupersede',
  );

  // Delegated body must not keep any payload construction/validation logic.
  const stripped = body.replace(/return runSupersede\([\s\S]*?\);/, '');
  for (const banned of [
    'validateMemoryRecord',
    'validateMemoryEvent',
    'normalizeMemoryRecord',
    'generateMemoryId',
    'generateLinkId',
    'generateEventId',
    'makeProvenance',
    'cloneMemoryRecord',
    'cloneMemoryLink',
    'cloneMemoryEvent',
    'MEMORY_SCHEMA_VERSIONS',
    'Object.freeze',
    "status: 'superseded'",
  ]) {
    assert.ok(!stripped.includes(banned), `supersede body must not contain ${banned}`);
  }

  // Wrapper lives on the store; it may touch internals but only as a pass-through.
  const apiMatch = storeSource.match(/_supersedeStoreApi\(\) \{[\s\S]*?\n  \}/);
  assert.ok(apiMatch, '_supersedeStoreApi wrapper exists');
  assert.ok(apiMatch[0].includes('return runSupersede') === false, 'wrapper is not the delegation site');

  // The delegate never reaches into this/store and owns no storage statements.
  const code = delegateSource
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!code.includes('this.'), 'memory-supersede.js code never references this');
  for (const banned of ['_db', '_stmts', '_memories', '_events', '_links', 'Database', '_withTransaction']) {
    assert.ok(!code.includes(banned), `delegate must not touch store internals (${banned})`);
  }

  // Fail-closed: validation/persist failures all return { ok: false, error }.
  const errorReturns = delegateSource.match(/\{ ok: false, error:/g) || [];
  assert.ok(errorReturns.length >= 6, 'delegate keeps fail-closed validation payloads');
});

test('MS: pinned call sites — supersede delegation (post-MS count)', () => {
  const importLines = storeSource.match(DELEGATE_REQUIRE_REGEX) || [];
  assert.equal(importLines.length, 1, 'runSupersede require appears exactly once');

  const calls = (storeSource.match(/runSupersede\(/g) || []).length;
  assert.equal(calls, 1, 'runSupersede is invoked from exactly one call site');

  // _supersedeStoreApi appears twice: exactly one call site (supersede method)
  // plus its definition. No other method may build this wrapper.
  const apiSites = (storeSource.match(/_supersedeStoreApi\(\)/g) || []).length;
  assert.equal(apiSites, 2, '_supersedeStoreApi appears exactly twice (one build site + definition)');

  // No require cycle and no store-private refs in the delegate.
  assert.ok(!delegateSource.includes("require('./memory-store')"), 'no cycle back into memory-store');
  const code = delegateSource
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const refs = (code.match(/this\._[a-zA-Z]+/g) || []);
  assert.equal(refs.length, 0, 'delegate reads no store-private members');
});
