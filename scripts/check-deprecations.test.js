'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkDeprecations } = require('./check-deprecations');

const REPO_ROOT = path.join(__dirname, '..');

test('repo root passes deprecation policy', () => {
  const result = checkDeprecations({ root: REPO_ROOT });
  assert.equal(result.ok, true, result.report);
  assert.ok(result.tagCount >= 1, 'KernelV1 deprecation should be visible');
});

test('missing migration hint fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.12.0"}\n');
    fs.writeFileSync(path.join(root, 'lib.js'), '/** @deprecated old stuff */\nmodule.exports.old = 1;\n');
    const result = checkDeprecations({ root });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => /migration hint/.test(v)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
