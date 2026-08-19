'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-temporal.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('MS: temporal reads are delegated to lib/memory-temporal.js', () => {
  assert.ok(
    storeSource.includes("const { runTemporalQuery } = require('./memory-temporal');"),
    'lib/memory-store.js imports the temporal delegate',
  );

  const queryMatch = storeSource.match(/_queryTemporalMemories\(opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(queryMatch, '_queryTemporalMemories method still exists');
  assert.match(
    queryMatch[0],
    /_queryTemporalMemories\(opts = \{\}\) \{\s*return runTemporalQuery\(this\._temporalReadContext\(\), opts\);/,
    '_queryTemporalMemories is a one-line delegation',
  );

  const contextMatch = storeSource.match(/_temporalReadContext\(\) \{[\s\S]*?\n  \}/);
  assert.ok(contextMatch, '_temporalReadContext exists');
  assert.match(contextMatch[0], /memories: this\._memories/);

  for (const method of ['since', 'before', 'between']) {
    assert.match(
      storeSource,
      new RegExp(`${method}\\([^\\n]+\\) \\{\\s*return this\\._queryTemporalMemories\\(`),
      `${method} remains a thin temporal wrapper`,
    );
  }
});

test('MS: pinned call sites — temporal delegation remains read-only', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-temporal'\)/g) || []).length, 1, 'delegate require appears once');
  assert.equal((storeSource.match(/runTemporalQuery\(/g) || []).length, 1, 'runTemporalQuery has one call site');
  assert.equal((storeSource.match(/_temporalReadContext\(\)/g) || []).length, 2, 'context factory has one definition plus one call site');
  assert.equal((storeSource.match(/_queryTemporalMemories\(/g) || []).length, 4, 'helper has one definition plus three public wrappers');

  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back into memory-store');
  for (const banned of ['_db', '_stmts', '_withTransaction', 'persist(', 'appendEvent', 'context.memories.sort']) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch store internals (${banned})`);
  }

  assert.ok(delegateCode.includes('context.memories.values()'), 'delegate owns memory iteration');
  assert.ok(delegateCode.includes('memories.sort('), 'delegate owns deterministic temporal sorting');
  assert.ok(delegateCode.includes('memories: memories.map(cloneMemoryRecord)'), 'delegate clones returned records');
});
