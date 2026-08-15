'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { resolvePersistencePaths } = require('../persistencePaths');

test('persistence paths reject an in-root junction that resolves outside the configured root', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-persist-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-persist-outside-'));
  try {
    const link = path.join(rootDir, 'redirect'); fs.symlinkSync(outsideDir, link, 'junction');
    assert.throws(
      () => resolvePersistencePaths({ rootDir, memoryPath: path.join(link, 'memory.json') }),
      (error) => error.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
    );
    assert.throws(
      () => resolvePersistencePaths({ rootDir, dbPath: path.join(link, 'memory.db') }),
      (error) => error.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
    );
    assert.deepEqual(fs.readdirSync(outsideDir), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
