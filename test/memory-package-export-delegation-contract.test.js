const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-package-export.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('MS: exportPackage delegates to lib/memory-package-export.js', () => {
  assert.ok(
    storeSource.includes("const { runExportPackage } = require('./memory-package-export');"),
    'lib/memory-store.js imports the package-export delegate',
  );

  const exportMatch = storeSource.match(/exportPackage\(opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(exportMatch, 'exportPackage method still exists');
  assert.match(
    exportMatch[0],
    /exportPackage\(opts = \{\}\) \{\s*return runExportPackage\(\{\s*memories: this\._memories,\s*events: this\._events,\s*links: this\._links,\s*\}, opts\);/,
    'exportPackage is a thin delegation wrapper',
  );
});

test('MS: pinned call site — package export remains read-only', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-package-export'\)/g) || []).length, 1, 'delegate require appears once');
  assert.equal((storeSource.match(/runExportPackage\(/g) || []).length, 1, 'runExportPackage has one call site');

  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this/store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back into memory-store');
  for (const banned of ['_db', '_stmts', '_withTransaction', '_persistenceError', 'context.memories.set', 'context.events.push', 'context.links.push']) {
    assert.ok(!delegateCode.includes(banned), `delegate must remain read-only (${banned})`);
  }

  assert.ok(delegateCode.includes('validateMemoryPackage(pkg)'), 'delegate owns package validation');
  assert.ok(delegateCode.includes('return { ok: true, package: deepClone(pkg) }'), 'delegate owns the single deep-clone return boundary');
  assert.equal((delegateCode.match(/context\.memories\.values\(\)/g) || []).length, 1, 'delegate reads memories through the supplied context');
  assert.equal((delegateCode.match(/context\.events/g) || []).length, 1, 'delegate reads events through the supplied context');
  assert.equal((delegateCode.match(/context\.links/g) || []).length, 1, 'delegate reads links through the supplied context');
});
