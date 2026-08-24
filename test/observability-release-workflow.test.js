'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const workflow = fs.readFileSync('.github/workflows/observability-release.yml', 'utf8');
const rollback = fs.readFileSync('docs/observability-release-rollback.md', 'utf8');

test('observability release workflow gates every required evidence class', () => {
  for (const command of [
    'node --test lib/observability/*.test.js', 'node --test backupRestore.test.js',
    'npm run test:observability-load', 'npm run test:observability-soak',
    'npm run check:package-closure', 'npm run verify:tarball',
  ]) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
});

test('rollback checklist is fail-closed and requires restored-data verification', () => {
  assert.match(rollback, /OBSERVABILITY_SCHEMA_VERSION_UNSUPPORTED/);
  assert.match(rollback, /partial receipt is not success/i);
  assert.match(rollback, /cross-workspace reads remain denied/i);
  assert.match(rollback, /Merely starting the process is insufficient/);
});

