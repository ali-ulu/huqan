'use strict';

// #3635: the help text advertises `restore [--dry-run] [path]`, but the bare
// positional spelling `restore <path>` (and `geri yükle <path>`) was not wired
// in the parser, so typing it produced "Unknown command: restore <path>". The
// handler already accepts a positional `backupDir`; only the rule was missing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCommand } = require('../lib/command-parser');

const cases = [
  ['restore backups/bk2', 'backups/bk2'],
  ['geri yukle backups/bk2', 'backups/bk2'],
  ['geri yükle backups/bk2', 'backups/bk2'],
];

test('a bare positional restore path resolves to the same backupDir as the other spellings', () => {
  for (const [input, backupDir] of cases) {
    const parsed = parseCommand(input, {});
    assert.equal(parsed.command, 'restore', `${input} must parse as restore`);
    assert.deepEqual(parsed.args, { backupDir }, `${input} must carry the positional path`);
  }
});

test('the dry-run and prefix spellings keep their own arg shapes', () => {
  const dryRun = parseCommand('restore --dry-run backups/bk2', {});
  assert.deepEqual(dryRun.args, { dryRun: true, backupDir: 'backups/bk2' });

  const prefixed = parseCommand('restore: backups/bk2', {});
  assert.equal(prefixed.command, 'restore');
  assert.equal(prefixed.args, 'backups/bk2');

  const bare = parseCommand('restore', {});
  assert.equal(bare.command, 'restore');
  assert.equal(bare.args, '');
});

test('a flag-shaped second token is not swallowed as a positional path', () => {
  for (const input of ['restore --dry-run', 'restore -x', 'restore --force backups/bk2']) {
    const parsed = parseCommand(input, {});
    assert.notDeepEqual(parsed.args, { backupDir: input.split(/\s+/).slice(1).join(' ') });
  }
  assert.equal(parseCommand('restore -x', {}).command, 'anlamadım');
});

test('a positional backup path is not case-folded', () => {
  const parsed = parseCommand('restore Backups/MyBackup-01', {});
  assert.deepEqual(parsed.args, { backupDir: 'Backups/MyBackup-01' });
});
