'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AUTHORITY_BUNDLE_FILES, ALLOWED_BUILTINS } = require('../lib/authority/bundle-manifest');

const ROOT = path.join(__dirname, '..');
// Static scan of CommonJS requires. It is a guard against accidents, not
// against a malicious edit: dynamic forms (require(variable), import(),
// createRequire) are invisible to it, which is why the runtime test below
// loads the bundle and inspects what node actually loaded.
const REQUIRE = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;

function bundleViolations(files, readSource, resolve) {
  const listed = new Set(files);
  const violations = [];
  for (const file of files) {
    for (const [, , spec] of readSource(file).matchAll(REQUIRE)) {
      if (spec.startsWith('node:')) {
        if (!ALLOWED_BUILTINS.includes(spec.slice(5))) violations.push(`${file}: builtin ${spec} is not allowed`);
      } else if (!spec.startsWith('.')) {
        violations.push(`${file}: package ${spec}`);
      } else if (!listed.has(resolve(file, spec))) {
        violations.push(`${file}: ${resolve(file, spec)} is outside the bundle`);
      }
    }
  }
  return violations;
}

const readRepoFile = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const resolveRepoSpec = (file, spec) => path.relative(ROOT, require.resolve(path.resolve(ROOT, path.dirname(file), spec)))
  .split(path.sep).join('/');

test('the authority bundle is closed over its requires', () => {
  assert.deepEqual(bundleViolations(AUTHORITY_BUNDLE_FILES, readRepoFile, resolveRepoSpec), []);
});

test('the closure check reports every way out of the bundle', () => {
  const sources = {
    'lib/authority/a.js': "require('node:crypto'); require('./b');",
    'lib/authority/b.js': "require ( 'node:child_process' ); require(`better-sqlite3`); require('../kernel-factory');",
  };
  const resolve = (file, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(file), `${spec}.js`));
  assert.deepEqual(bundleViolations(Object.keys(sources), file => sources[file], resolve), [
    'lib/authority/b.js: builtin node:child_process is not allowed',
    'lib/authority/b.js: package better-sqlite3',
    'lib/authority/b.js: lib/kernel-factory.js is outside the bundle',
  ]);
});

test('loading the bundle loads nothing outside it', () => {
  const script = `
    const path = require('node:path');
    const root = process.argv[1];
    for (const file of JSON.parse(process.argv[2])) require(path.join(root, file));
    const loaded = Object.keys(require.cache).map(f => path.relative(root, f).split(path.sep).join('/'));
    process.stdout.write(JSON.stringify(loaded));
  `;
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const run = spawnSync(process.execPath, ['-e', script, ROOT, JSON.stringify(AUTHORITY_BUNDLE_FILES)], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  const outside = JSON.parse(run.stdout).filter(file => !AUTHORITY_BUNDLE_FILES.includes(file));
  assert.deepEqual(outside, []);
});

test('every bundle file exists and ships in the package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const file of AUTHORITY_BUNDLE_FILES) {
    assert.ok(fs.statSync(path.join(ROOT, file)).isFile(), file);
    assert.ok(pkg.files.includes(file), `${file} is missing from package.json#files`);
  }
});
