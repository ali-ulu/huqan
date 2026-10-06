const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isPathWithinRoot, resolvePathWithinRoot } = require('../lib/path-safety');

test('path-safety: resolvePathWithinRoot allows paths inside vault/root', () => {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-safe-root-')));
  const inside = path.join(rootDir, 'notes', 'memory.json');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, '{}', 'utf8');

  try {
    assert.equal(isPathWithinRoot(rootDir, inside), true);
    assert.equal(resolvePathWithinRoot(rootDir, inside), path.resolve(inside));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('path-safety: resolvePathWithinRoot blocks vault escape attempts', () => {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-safe-root-')));
  const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-safe-outside-')));
  const outside = path.join(outsideDir, 'memory.json');
  fs.writeFileSync(outside, '{}', 'utf8');

  try {
    assert.equal(isPathWithinRoot(rootDir, outside), false);
    assert.throws(
      () => resolvePathWithinRoot(rootDir, path.join(rootDir, '..', path.basename(outside))),
      /allowed root/i
    );
    assert.throws(
      () => resolvePathWithinRoot(rootDir, outside),
      /allowed root/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('path-safety: missing targets are checked through their nearest real ancestor', () => {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-path-root-')));
  const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-path-outside-')));
  const link = path.join(rootDir, 'redirect');
  try {
    fs.symlinkSync(outsideDir, link, 'junction');
    assert.throws(
      () => resolvePathWithinRoot(rootDir, path.join(link, 'not-created', 'memory.json'), { allowMissing: true }),
      (error) => error.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
    );
    const safe = resolvePathWithinRoot(rootDir, path.join(rootDir, 'new', 'memory.json'), { allowMissing: true });
    assert.equal(safe, path.join(fs.realpathSync(rootDir), 'new', 'memory.json'));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('path-safety: a root reached through a link accepts candidates spelled through its real path', () => {
  // macOS os.tmpdir() is /var/..., a link to /private/var/...; walkers descend
  // realpath'd directories and hand those spellings back against the link root.
  const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-path-real-')));
  const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-path-outside-')));
  const linkParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-path-link-')));
  const linkRoot = path.join(linkParent, 'root');
  const inside = path.join(realRoot, 'notes', 'memory.json');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, '{}', 'utf8');
  try {
    fs.symlinkSync(realRoot, linkRoot, 'junction');
    assert.equal(resolvePathWithinRoot(linkRoot, inside), inside);
    assert.throws(
      () => resolvePathWithinRoot(linkRoot, path.join(realRoot, '..', path.basename(outsideDir)), { allowMissing: true }),
      (error) => error.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
    );
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('path-safety: resolvePathWithinRoot fails closed on control characters and overlong paths', () => {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-malformed-root-')));
  try {
    for (const candidate of [
      path.join(rootDir, 'memory\u0000.json'),
      path.join(rootDir, 'memory\u001f.json'),
      path.join(rootDir, 'memory\u007f.json'),
      path.join(rootDir, 'x'.repeat(1025)),
    ]) {
      assert.throws(
        () => resolvePathWithinRoot(rootDir, candidate, { allowMissing: true }),
        (error) => error.code === 'PATH_MALFORMED',
      );
    }
    assert.throws(
      () => resolvePathWithinRoot(`${rootDir}\u0000`, path.join(rootDir, 'memory.json'), { allowMissing: true }),
      (error) => error.code === 'ROOT_PATH_MALFORMED',
    );
    assert.throws(
      () => resolvePathWithinRoot('x'.repeat(1025), path.join(rootDir, 'memory.json'), { allowMissing: true }),
      (error) => error.code === 'ROOT_PATH_MALFORMED',
    );
    // A boundary-length, control-free path is still admitted.
    const boundary = path.join(rootDir, 'a'.repeat(1024 - rootDir.length - 1));
    assert.equal(boundary.length, 1024);
    assert.equal(resolvePathWithinRoot(rootDir, boundary, { allowMissing: true }), boundary);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
