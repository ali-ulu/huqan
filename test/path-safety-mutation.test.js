'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  canonicalizePath,
  createPathError,
  isPathWithinRoot,
  resolvePathWithinRoot,
  withRealpathSpellings,
} = require('../lib/path-safety');

test('createPathError only attaches supplied context and preserves code', () => {
  const bare = createPathError('X', 'message');
  assert.equal(bare.code, 'X');
  assert.equal(bare.message, 'message');
  assert.equal(Object.hasOwn(bare, 'rootPath'), false);
  assert.equal(Object.hasOwn(bare, 'path'), false);

  const rich = createPathError('Y', 'detail', '/root', '/root/file');
  assert.equal(rich.code, 'Y');
  assert.equal(rich.rootPath, '/root');
  assert.equal(rich.path, '/root/file');
});

test('isPathWithinRoot accepts exact/descendant and rejects siblings and parent traversal', () => {
  const base = path.join(os.tmpdir(), 'path-safety-root');
  assert.equal(isPathWithinRoot(base, base), true);
  assert.equal(isPathWithinRoot(base, path.join(base, 'a', 'b')), true);
  assert.equal(isPathWithinRoot(base, path.join(base, '..', 'outside')), false);
  assert.equal(isPathWithinRoot(base, path.join(os.tmpdir(), 'path-safety-root-elsewhere')), false);
});

test('canonicalizePath distinguishes existing, missing-allowed and missing-forbidden paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-canonical-'));
  try {
    const existing = path.join(root, 'existing');
    fs.mkdirSync(existing);
    assert.equal(canonicalizePath(existing, false), fs.realpathSync(existing));

    const missing = path.join(root, 'a', 'b', 'c.txt');
    assert.equal(canonicalizePath(missing, true), path.join(fs.realpathSync(root), 'a', 'b', 'c.txt'));
    assert.throws(() => canonicalizePath(missing, false), (error) => {
      assert.equal(error.code, 'PATH_NOT_FOUND');
      assert.equal(error.path, path.resolve(missing));
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('withRealpathSpellings deduplicates resolved and real spellings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-realpath-'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-link-'));
  const link = path.join(parent, 'link');
  try {
    fs.symlinkSync(root, link, 'junction');
    const spellings = withRealpathSpellings([link, link, root]);
    assert.ok(spellings.includes(path.resolve(link)));
    assert.ok(spellings.includes(fs.realpathSync(root)));
    assert.equal(new Set(spellings).size, spellings.length);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePathWithinRoot validates root and missing-path policy exactly', () => {
  assert.throws(() => resolvePathWithinRoot('', 'x'), (error) => error.code === 'ROOT_PATH_REQUIRED');
  assert.throws(() => resolvePathWithinRoot(null, 'x'), (error) => error.code === 'ROOT_PATH_REQUIRED');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-resolve-'));
  try {
    const missing = path.join(root, 'new', 'file.txt');
    assert.throws(() => resolvePathWithinRoot(root, missing), (error) => error.code === 'PATH_NOT_FOUND');
    assert.equal(
      resolvePathWithinRoot(root, missing, { allowMissing: true }),
      path.join(fs.realpathSync(root), 'new', 'file.txt'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
