// Pin-locked contract: the query/sort/pagination decision logic lives in
// lib/memory-query-engine.js (MS: #328), and the class methods on MemoryStore
// are one-line delegations. The pinned call-site counts below MUST be updated
// together with any structural change to lib/memory-store.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const ENGINE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-query-engine.js');
const ENGINE_IMPORT = "const { runQuery } = require('./memory-query-engine');";
const ENGINE_REQUIRE_REGEX = /require\('\.\/memory-query-engine'\)/;

const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const engineSource = fs.readFileSync(ENGINE_SOURCE, 'utf8');

// Strip comment lines before structural checks so example delegation snippets
// in the delegate's header comment do not count as real references.
const engineCode = engineSource
  .split('\n')
  .map(line => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('MS: query logic is delegated to lib/memory-query-engine.js (only ownership moved)', () => {
  assert.ok(
    storeSource.includes(ENGINE_IMPORT),
    'lib/memory-store.js imports runQuery from lib/memory-query-engine.js',
  );

  // Delegated body: zero filter/sort/pagination logic remains in the class.
  const queryMatch = storeSource.match(/query\(opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(queryMatch, 'query method still exists');
  const queryBody = queryMatch[0];
  assert.ok(
    /query\(opts = \{\}\) \{\s*return runQuery\(/.test(queryBody),
    'query is a one-line delegation to runQuery (no inline filter logic)',
  );
  // The delegation line itself builds the context object (this is expected);
  // strip it before checking for leftover inline logic.
  const logicBody = queryBody.replace(/return runQuery\([\s\S]*?\);/, '');
  for (const banned of ['_memories.values()', 'localeCompare', 'cloneMemoryRecord']) {
    assert.ok(
      !logicBody.includes(banned),
      `query body must not contain inline logic (${banned})`,
    );
  }
  assert.ok(
    /search\(opts = \{\}\) \{\s*return this\.query\(opts\);\s*\}/.test(storeSource),
    'search alias stays a one-line delegation through query',
  );

  // The delegate owns the decisions; it must not reach into this/store.
  assert.ok(!engineCode.includes('this.'), 'memory-query-engine.js code never references this');
  for (const banned of ['_db', '_stmts', 'Database', 'runWithBusyRetry']) {
    assert.ok(
      !engineCode.includes(banned),
      `delegate must not touch storage internals (${banned})`,
    );
  }

  // Fail-closed: every validation failure returns { ok: false, error } with a
  // code, so a missing filter can never silently widen the result set.
  const errorReturns = engineSource.match(/\{ ok: false, error:/g) || [];
  assert.ok(errorReturns.length >= 7, 'delegate keeps fail-closed validation payloads');
});

test('MS: pinned call sites — query delegation (post-MS count)', () => {
  // After MS delegation: runQuery is imported once and called from exactly one
  // class site (MemoryStore.query). search reaches it through query.
  const importLines = storeSource.match(ENGINE_REQUIRE_REGEX) || [];
  assert.equal(importLines.length, 1, 'runQuery require appears exactly once');

  const runQueryCalls = (storeSource.match(/runQuery\(/g) || []).length;
  assert.equal(runQueryCalls, 1, 'runQuery is invoked from exactly one call site (query method)');

  const queryDelegations = (storeSource.match(/return this\.query\(opts\);/g) || []).length;
  assert.equal(queryDelegations, 1, 'search remains the single query alias');

  // The delegate itself does not re-enter the store (no require cycle into
  // memory-store and no references to store-private members).
  assert.ok(!engineSource.includes("require('./memory-store')"), 'no cycle back into memory-store');
  const storePrivateRefs = (engineCode.match(/this\._[a-zA-Z]+/g) || []);
  assert.equal(storePrivateRefs.length, 0, 'delegate reads no store-private members');
});
