'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

test('verify test suite enforces immutable GitHub Action pins', () => {
  const result = spawnSync(process.execPath, ['scripts/check-action-pins.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `action pin checker failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /GitHub Action pin check passed:/);
});
