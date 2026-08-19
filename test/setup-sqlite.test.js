'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INSTALL_ARGS,
  REBUILD_ARGS,
  classifyLoadFailure,
  commandLabel,
} = require('../scripts/setup-sqlite');

test('SQLite setup uses the locked optional-dependency install command', () => {
  assert.deepEqual(INSTALL_ARGS, ['ci', '--include=optional', '--no-audit', '--no-fund']);
  assert.match(commandLabel(INSTALL_ARGS), /npm(?:\.cmd)? ci --include=optional --no-audit --no-fund/);
});

test('SQLite setup classifies an absent native addon as not installed', () => {
  const failure = classifyLoadFailure(Object.assign(new Error('Cannot find module better-sqlite3'), {
    code: 'MODULE_NOT_FOUND',
  }));
  assert.equal(failure.kind, 'not_installed');
  assert.match(failure.hint, /npm ci/);
});

test('SQLite setup classifies a native ABI error as rebuildable', () => {
  const failure = classifyLoadFailure(Object.assign(new Error('was compiled against a different Node.js version'), {
    code: 'ERR_DLOPEN_FAILED',
  }));
  assert.equal(failure.kind, 'abi_mismatch');
  assert.match(failure.hint, /npm rebuild better-sqlite3/);
});

test('SQLite setup keeps the rebuild command scoped to better-sqlite3', () => {
  assert.deepEqual(REBUILD_ARGS, ['rebuild', 'better-sqlite3', '--no-audit', '--no-fund']);
});
