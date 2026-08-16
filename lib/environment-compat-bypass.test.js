'use strict';

/**
 * Fail if shipped runtime code reads a HUQAN_/AXIOM_ variable straight off
 * `process.env` instead of going through readCompatibleEnvironmentVariable().
 *
 * environment-compat.js is the single choke point for the AXIOM -> HUQAN
 * rename: it resolves the canonical name, falls back to the legacy one, and
 * throws HUQAN_ENV_CONFLICT when both are set to different values. A module
 * that reads process.env.HUQAN_X directly silently loses the AXIOM_X fallback
 * and the conflict check for that one variable, so a deployment still on the
 * legacy name breaks in that module only — at runtime, in production, with no
 * failing test.
 *
 * The invariant currently holds (0 bypasses across the runtime). This test
 * keeps it that way; without it the rule lives only in reviewer habit.
 *
 * Test files are excluded: setting process.env.HUQAN_X directly is exactly how
 * a test arranges its environment, and the invariant protects the shipped
 * runtime, not the harness.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

const EXCLUDE = /(^|\/)(node_modules|graphify-out)\//;
const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

// The shim itself must touch process.env — it is the thing being delegated to.
const ALLOWED = new Set(['lib/environment-compat.js']);

const BYPASS = /process\.env\.(HUQAN|AXIOM)_[A-Z0-9_]+/g;

function listRuntimeFiles() {
  const out = execFileSync('git', ['ls-files', '*.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((file) => !EXCLUDE.test(file))
    .filter((file) => !IS_TEST.test(file))
    .filter((file) => !ALLOWED.has(file));
}

test('runtime code reads HUQAN_/AXIOM_ env vars only through environment-compat', () => {
  const violations = [];

  for (const file of listRuntimeFiles()) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(BYPASS)) {
        violations.push(`${file}:${index + 1}  ${match[0]}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    'direct process.env access bypasses the AXIOM_ fallback and the '
      + 'HUQAN_ENV_CONFLICT check. Use readCompatibleEnvironmentVariable(suffix) '
      + `from lib/environment-compat.js instead:\n  ${violations.join('\n  ')}`,
  );
});

test('the bypass detector actually matches a bypass', () => {
  // Guards the guard: a regex typo would make the test above pass vacuously.
  const sample = 'const key = process.env.HUQAN_API_KEY || process.env.AXIOM_DB_PATH;';
  const found = [...sample.matchAll(BYPASS)].map((match) => match[0]);
  assert.deepEqual(found, ['process.env.HUQAN_API_KEY', 'process.env.AXIOM_DB_PATH']);
});

test('the file list is non-empty and excludes tests and the shim', () => {
  // Guards the guard: a broken git ls-files would scan nothing and pass.
  const files = listRuntimeFiles();
  assert.ok(files.length > 50, `expected a real runtime file list, got ${files.length}`);
  assert.ok(!files.includes('lib/environment-compat.js'));
  assert.ok(!files.some((file) => file.endsWith('.test.js')));
});
