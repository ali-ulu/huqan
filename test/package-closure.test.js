'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  analyzePackageClosure,
  loadTimeRequires,
  loadTimeEntryPoints,
  publishedFiles,
} = require('../scripts/check-package-closure');

const REPO_ROOT = path.resolve(__dirname, '..');

// ─── the invariant ───────────────────────────────────────────────────────────

test('every module the installed package loads is published', () => {
  const { missing } = analyzePackageClosure({ root: REPO_ROOT });
  const report = [...missing.keys()].sort()
    .map((file) => `  ${file}  (required by ${missing.get(file).join(', ')})`)
    .join('\n');
  assert.deepEqual([...missing.keys()], [],
    'these modules run at install time but are not in package.json#files, so an '
    + 'installed consumer gets "Cannot find module" for each:\n' + report);
});

// ─── the analysis itself ─────────────────────────────────────────────────────
//
// package.json#files is an allowlist nobody reads top to bottom, so the check
// above is only worth what its walk is worth. These pin the walk's shape: a
// version that silently reached nothing would still report an empty `missing`.

test('the walk starts from the manifest, not from a restated list', () => {
  const published = publishedFiles(REPO_ROOT);
  const entries = loadTimeEntryPoints(REPO_ROOT, published);
  // main and every declared bin, read from package.json.
  assert.ok(entries.includes('index.js'));
  assert.ok(entries.includes('cli.js'));
  assert.ok(entries.includes('bin/huqan-mcp.js'));
  // plugin.js loads the plugin directory with readdirSync, so no static walk
  // from main can see these; they are entry points in their own right.
  assert.ok(entries.includes('plugins/company-brain.js'));
  assert.ok(entries.includes('adapters/markdown-adapter.js'));
});

test('the closure is substantial, so an empty result would not read as a pass', () => {
  const { reached } = analyzePackageClosure({ root: REPO_ROOT });
  assert.ok(reached.length > 150, `only ${reached.length} modules reached`);
  for (const file of ['graph.js', 'lib/verify.js', 'lib/memory-store.js', 'lib/safe-file-walk.js']) {
    assert.ok(reached.includes(file), `${file} should be in the load-time closure`);
  }
});

test('a directory entry in files expands to the files inside it', () => {
  // The manifest lists `lib/error-prevention` bare, so a membership test
  // against the array alone would treat everything inside it as unpublished.
  const published = publishedFiles(REPO_ROOT);
  const inside = [...published].filter((f) => f.startsWith('lib/error-prevention/'));
  assert.ok(inside.length > 0, 'directory entries must expand');
});

// ─── load-time vs deferred ───────────────────────────────────────────────────
//
// The distinction the whole check rests on. This repository publishes modules
// whose own dependencies are repo-only and guards them at the call site; a
// scanner that could not tell the two apart would report that design as a bug.

test('a require at module scope counts, one inside a guard does not', () => {
  assert.deepEqual(loadTimeRequires("const x = require('./a');"), ['./a']);
  assert.deepEqual(loadTimeRequires("function f() { return require('./a'); }"), []);
  assert.deepEqual(loadTimeRequires("try { require('./a'); } catch (_) {}"), []);
  assert.deepEqual(loadTimeRequires("if (flag) { require('./a'); }"), []);
});

test('requires named in comments and strings do not count', () => {
  assert.deepEqual(loadTimeRequires("// see require('./a')\n"), []);
  assert.deepEqual(loadTimeRequires("/* require('./a') */"), []);
  assert.deepEqual(loadTimeRequires("const s = \"require('./a')\";"), []);
  assert.deepEqual(loadTimeRequires('const s = `require(\'./a\')`;'), []);
});

test('bare package specifiers are out of scope', () => {
  // Third-party resolution is package.json#dependencies' problem, not the
  // files allowlist's.
  assert.deepEqual(loadTimeRequires("const fs = require('node:fs');"), []);
  assert.deepEqual(loadTimeRequires("const yaml = require('js-yaml');"), []);
});

test('the guarded repo-only families stay out of the closure', () => {
  // server.js requires the V5 import route inside a try/catch, and
  // lib/a2a/exchange-route.js does the same for the bounded exchange, so the
  // installed package boots without them and the routes go unavailable. If
  // either becomes a load-time require, this test is how that gets noticed --
  // the check above would then demand the whole V5 family be published.
  const { reached } = analyzePackageClosure({ root: REPO_ROOT });
  for (const file of reached) {
    assert.ok(!file.startsWith('lib/v5/'), `${file} must not load at install time`);
    assert.notEqual(file, 'lib/a2a/bounded-exchange.js');
  }
});
