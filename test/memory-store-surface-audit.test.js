'use strict';

/**
 * A standing audit of MemoryStore's public surface: what the class exposes,
 * what production actually calls, and what the published type declaration
 * promises. The three are not the same, and the gaps are the point of the file.
 *
 * MemoryStore has 36 public methods. Six of them have a non-test caller. One --
 * `search()` -- has no caller anywhere, not even a test: it is a three-line
 * alias for `query()`. The rest are exercised only by the memory suite, which
 * means the tests are the only thing currently defining what they must do.
 *
 * That is not a bug list. A store is allowed to offer more than one consumer
 * happens to use, and `lib/memory-store.js` is reachable as
 * `require('huqan/lib/memory-store')` because package.json ships it and
 * declares no `exports` map -- so an external consumer this repository cannot
 * see may be calling any of them. What is not allowed is for the difference to
 * be invisible: a method quietly added to the class, or a caller quietly
 * appearing for something classified as unused, should show up in review rather
 * than in a later archaeology session.
 *
 * Scope. This audit classifies the surface; it does not move code. Splitting
 * lib/memory-store.js is governed by docs/v4/big-file-refactor-gate.md, which
 * says a large file is split immediately before the PR that must edit it
 * heavily, and not "for cleanliness". No such PR exists today.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const MemoryStore = require('../lib/memory-store');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Methods with at least one caller outside lib/memory-store.js and outside a
 * test file, each with where that caller is.
 *
 * lib/error-prevention/ is the substantive consumer and reaches the store
 * directly; `require('huqan').createErrorPrevention` is a published entry
 * point, so this path is public product surface rather than an internal
 * shortcut. server.js reaches the same store through `kernel.memory`.
 */
const PRODUCTION_SURFACE = Object.freeze({
  store: 'lib/error-prevention/store.js, benchmarks/bench-memory-scale.js',
  get: 'lib/error-prevention/{store,evidence,integrity,engine}.js',
  list: 'lib/error-prevention/store.js, server.js (kernel.memory.list)',
  supersede: 'lib/error-prevention/{store,engine,lifecycle}.js',
  queryLinks: 'server.js (kernel.memory.queryLinks)',
  close: 'kernel.js',
});

/**
 * Methods no caller outside the memory suite reaches. They are covered by
 * tests, so their behavior is pinned; what is absent is a consumer.
 */
const TEST_ONLY_SURFACE = Object.freeze([
  'before', 'between', 'contradict', 'eventsForMemory', 'exportPackage',
  'findByContentHash', 'findById', 'findByKind', 'findBySourceRef',
  'findByStatus', 'findLinkedMemories', 'findLinks', 'getBacklinks',
  'getEvents', 'getLinks', 'history', 'importPackage', 'link', 'linkMemories',
  'linksForMemory', 'load', 'memoriesBetween', 'patchMetadata', 'query',
  'save', 'since', 'timeline', 'tombstone', 'traverseLinks',
]);

/**
 * Methods with no caller at all, each with what it is.
 *
 * Being unreached is not by itself a reason to delete: without an `exports`
 * map, `require('huqan/lib/memory-store').prototype.search` is reachable by
 * any installed consumer, so removing one is a breaking change for someone
 * this repository cannot enumerate. Recording it is what this file is for;
 * removing it is a release decision.
 */
const UNREACHED_SURFACE = Object.freeze({
  search: 'a three-line alias that forwards to query() unchanged',
});

/**
 * What the declarations promise about `kernel.memory`, against what production
 * calls through it.
 *
 * This started as a recorded gap: kernel.d.ts declared `memory: { close() }`
 * while server.js called kernel.memory.list() and .queryLinks(), and
 * kernel.v2.d.ts -- the canonical declaration, since require('huqan') resolves
 * to KernelV2 -- declared no memory member at all. The gap is now closed by
 * the declarations, and this list is the ratchet on it: a production call
 * appearing for an undeclared method fails here.
 *
 * The declared set is deliberately the consumed surface, not the whole class.
 * The other 33 public methods stay classified above rather than published.
 */
const KERNEL_DECLARED_MEMORY_METHODS = Object.freeze(['close', 'list', 'queryLinks']);
const KERNEL_MEMORY_CALLS_UNDECLARED = Object.freeze([]);

function publicMethods(ctor) {
  return Object.getOwnPropertyNames(ctor.prototype)
    .filter((name) => name !== 'constructor' && !name.startsWith('_'))
    .sort();
}

/** Every tracked .js file except node_modules and the store's own source. */
function sourceFiles() {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (rel === 'lib/memory-store.js') continue;
      out.push(rel);
    }
  };
  walk('.');
  return out;
}

/**
 * Call sites for `<receiver>.<method>(` where the receiver is plausibly a
 * memory store.
 *
 * Deliberately receiver-scoped: a bare `.get(` matches Map, URLSearchParams and
 * every other object in the repository, and counting those would make the
 * audit's central claim meaningless. The cost is that a store held under an
 * unusual name is missed, which is why the classification lists above are
 * asserted against the prototype rather than derived from this scan.
 */
const RECEIVERS = '(?:memory|memoryStore|store|store1|store2|_memory|this\\.store|this\\.memory|this\\.memoryStore)';

function callSites(method) {
  const pattern = new RegExp(`${RECEIVERS}\\.${method}\\(`);
  const hits = { production: [], test: [] };
  for (const rel of sourceFiles()) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    if (!pattern.test(source)) continue;
    (rel.endsWith('.test.js') ? hits.test : hits.production).push(rel);
  }
  return hits;
}

test.describe('MemoryStore public surface audit', () => {
  test('every public method is classified exactly once', () => {
    const classified = [
      ...Object.keys(PRODUCTION_SURFACE),
      ...TEST_ONLY_SURFACE,
      ...Object.keys(UNREACHED_SURFACE),
    ].sort();
    const actual = publicMethods(MemoryStore);

    const unclassified = actual.filter((name) => !classified.includes(name));
    assert.deepStrictEqual(unclassified, [],
      `these are public on MemoryStore but not classified here:\n  ${unclassified.join('\n  ')}`);

    const stale = classified.filter((name) => !actual.includes(name));
    assert.deepStrictEqual(stale, [],
      `these are classified here but no longer public:\n  ${stale.join('\n  ')}`);

    assert.strictEqual(new Set(classified).size, classified.length,
      'a method appears in more than one classification');
  });

  test('every method claimed to have a production caller has one', () => {
    const claimedButNot = Object.keys(PRODUCTION_SURFACE)
      .filter((name) => callSites(name).production.length === 0);
    assert.deepStrictEqual(claimedButNot, [],
      `listed as production surface but no non-test caller found:\n  ${claimedButNot.join('\n  ')}`);
  });

  test('every method claimed to be test-only has tests and no production caller', () => {
    const withProduction = [];
    const withoutTests = [];
    for (const name of TEST_ONLY_SURFACE) {
      const hits = callSites(name);
      if (hits.production.length > 0) withProduction.push(`${name} (${hits.production.join(', ')})`);
      if (hits.test.length === 0) withoutTests.push(name);
    }
    // A production caller appearing is good news, not a failure of the code --
    // but the classification has to move with it, which is what this catches.
    assert.deepStrictEqual(withProduction, [],
      `classified test-only but now called from production; reclassify:\n  ${withProduction.join('\n  ')}`);
    assert.deepStrictEqual(withoutTests, [],
      `classified test-only but no test calls it either:\n  ${withoutTests.join('\n  ')}`);
  });

  test('every method claimed unreached has no caller at all', () => {
    for (const [name, note] of Object.entries(UNREACHED_SURFACE)) {
      const hits = callSites(name);
      assert.deepStrictEqual([...hits.production, ...hits.test], [],
        `${name} is classified unreached (${note}) but has callers`);
    }
  });

  test('every unreached entry says what it is', () => {
    for (const [name, note] of Object.entries(UNREACHED_SURFACE)) {
      assert.ok(note && note.length > 20, `${name} has no real note recorded`);
    }
  });

  test('kernel.d.ts declares the memory surface it is recorded as declaring', () => {
    const declaration = fs.readFileSync(path.join(REPO_ROOT, 'kernel.d.ts'), 'utf8');
    const block = declaration.match(/\n {2}memory: \{([^}]*)\}/);
    assert.ok(block, 'kernel.d.ts no longer has a `memory:` block; this audit needs updating');

    const declared = [...block[1].matchAll(/([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g)]
      .map((match) => match[1])
      .sort();
    assert.deepStrictEqual(declared, [...KERNEL_DECLARED_MEMORY_METHODS].sort(),
      'the declared kernel.memory surface changed; re-audit the gap below');
  });

  test('the canonical declaration carries the memory member too', () => {
    // The audit read kernel.d.ts alone at first, which understated the gap:
    // require('huqan') resolves to KernelV2, so kernel.v2.d.ts is the
    // declaration a consumer of the canonical entry point actually reads.
    const v2 = fs.readFileSync(path.join(REPO_ROOT, 'kernel.v2.d.ts'), 'utf8');
    assert.match(v2, /readonly memory\s*:\s*Kernel\['memory'\]\s*;/,
      'kernel.v2.d.ts must forward the memory type; kernel.v2.js forwards the value');
  });

  test('the undeclared kernel.memory calls are exactly the known ones', () => {
    // Narrower than callSites(): only `kernel.memory.X(`, which is what the
    // kernel.d.ts block governs.
    const found = new Set();
    for (const rel of sourceFiles()) {
      if (rel.endsWith('.test.js')) continue;
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const match of source.matchAll(/kernel\.memory\.([a-zA-Z][a-zA-Z0-9_]*)\(/g)) {
        if (!KERNEL_DECLARED_MEMORY_METHODS.includes(match[1])) found.add(match[1]);
      }
    }
    assert.deepStrictEqual([...found].sort(), [...KERNEL_MEMORY_CALLS_UNDECLARED].sort(),
      'production reaches kernel.memory through a method the declaration does not cover; '
      + 'either widen kernel.d.ts in the PR that owns that contract, or update this list');
  });
});
