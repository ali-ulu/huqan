'use strict';

/**
 * Evidence that a missing/mismatched native SQLite binary produces an
 * actionable message rather than a raw loader dump, and that the two failure
 * modes are told apart (they have different fixes: install vs rebuild).
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  describeSqliteLoadFailure,
  sqliteUnavailableError,
} = require('../lib/sqlite-availability');

test('a not-installed failure tells the user to install', () => {
  const error = Object.assign(new Error("Cannot find module 'better-sqlite3'"), {
    code: 'MODULE_NOT_FOUND',
  });

  const { kind, hint } = describeSqliteLoadFailure(error);

  assert.equal(kind, 'not_installed');
  assert.match(hint, /npm ci/);
  assert.doesNotMatch(hint, /npm rebuild/);
});

test('an ABI mismatch tells the user to rebuild, not reinstall from npm', () => {
  const error = Object.assign(new Error('was compiled against a different Node.js version'), {
    code: 'ERR_DLOPEN_FAILED',
  });

  const { kind, hint } = describeSqliteLoadFailure(error);

  assert.equal(kind, 'abi_mismatch');
  assert.match(hint, /npm rebuild better-sqlite3/);
  // The running Node version is the diagnostic fact the user needs here.
  assert.ok(hint.includes(process.version));
});

test('an ABI mismatch is detected from the message when no code is set', () => {
  const error = new Error('The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115.');

  assert.equal(describeSqliteLoadFailure(error).kind, 'abi_mismatch');
});

test('an unrecognised failure still surfaces the original message', () => {
  const { kind, hint } = describeSqliteLoadFailure(new Error('disk on fire'));

  assert.equal(kind, 'unknown');
  assert.match(hint, /disk on fire/);
});

test('sqliteUnavailableError keeps the caller context as the message prefix', () => {
  const cause = Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' });

  const error = sqliteUnavailableError('better-sqlite3 is required for v3 storage.', cause);

  // Callers and existing tests match on the context prefix; it must lead.
  assert.ok(error.message.startsWith('better-sqlite3 is required for v3 storage.'));
  assert.equal(error.code, 'HUQAN_SQLITE_UNAVAILABLE');
  assert.equal(error.reason, 'not_installed');
  assert.equal(error.cause, cause);
});

test('the existing memory-store error prefix is preserved', () => {
  const error = sqliteUnavailableError(
    'better-sqlite3 is required for SQLite memory storage.',
    Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }),
  );

  assert.match(error.message, /better-sqlite3 is required for SQLite memory storage/);
});
