'use strict';

/**
 * #4087 PR-4: the bounded directory scan the public receipt route's store
 * lookup is built on. The store's own tests reach the happy path; the arms
 * below are the refusals that only a direct call can drive, and each one is a
 * rule the bound exists to hold.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_DIRECTORY_ENTRIES,
  listRecordFileNames,
} = require('../lib/github-app-streaming-trust-store-files');

const IO_FAILED = 'GITHUB_APP_STREAMING_STORE_IO_FAILED';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-store-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a directory that does not exist lists as empty rather than failing', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(listRecordFileNames(path.join(dir, 'absent')), []);
});

test('only .json entries are returned, sorted, and non-records are skipped', (t) => {
  const dir = tempDir(t);
  for (const name of ['b.json', 'a.json', 'notes.txt', 'sub', '.hidden.json', 'c.json']) {
    if (name === 'sub') fs.mkdirSync(path.join(dir, name));
    else fs.writeFileSync(path.join(dir, name), '{}');
  }

  assert.deepEqual(listRecordFileNames(dir), ['.hidden.json', 'a.json', 'b.json', 'c.json']);
});

test('a directory that exceeds the entry bound is refused, not read partially', (t) => {
  const dir = tempDir(t);
  for (let index = 0; index <= MAX_DIRECTORY_ENTRIES; index += 1) {
    fs.writeFileSync(path.join(dir, `${index}.json`), '{}');
  }

  assert.throws(() => listRecordFileNames(dir), (error) => error.code === IO_FAILED);
  // The bound is on the returned record set, so a directory exactly at the
  // bound is still listable.
  fs.rmSync(path.join(dir, `${MAX_DIRECTORY_ENTRIES}.json`));
  assert.equal(listRecordFileNames(dir).length, MAX_DIRECTORY_ENTRIES);
});

test('a path that is a file, not a directory, is refused as an IO failure', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'not-a-directory');
  fs.writeFileSync(file, '{}');

  // ENOTDIR, not ENOENT: a non-directory must be a refusal, never "empty".
  assert.throws(() => listRecordFileNames(file), (error) => error.code === IO_FAILED);
});
