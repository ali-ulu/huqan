'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const {
  canonicalizePath,
  createPathError,
  isPathWithinRoot,
  readFileWithinRoot,
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
      assert.equal(error.message, 'Path does not exist');
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

// ---------------------------------------------------------------------------
// readFileWithinRoot (#4247). Every branch below is a mutant target: the type
// gate, the symlink refusal, the containment call and the error-code mapping
// each have to be observed, not merely executed, or the mutant survives.
// ---------------------------------------------------------------------------

function scratchRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-read-within-')));
}

test('readFileWithinRoot returns the exact bytes of a regular file inside the root', () => {
  const root = scratchRoot();
  try {
    const file = path.join(root, 'a', 'b.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from('hello\nworld\n');
    fs.writeFileSync(file, bytes);
    const read = readFileWithinRoot(root, path.join('a', 'b.txt'));
    assert.equal(Buffer.isBuffer(read), true);
    assert.deepEqual(read, bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot accepts an absolute candidate spelled through the root', () => {
  const root = scratchRoot();
  try {
    const file = path.join(root, 'plain.txt');
    fs.writeFileSync(file, 'x');
    assert.equal(readFileWithinRoot(root, file).toString(), 'x');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot reports PATH_NOT_FOUND for a path that is not there', () => {
  const root = scratchRoot();
  try {
    assert.throws(() => readFileWithinRoot(root, 'missing.txt'), (error) => {
      assert.equal(error.code, 'PATH_NOT_FOUND');
      assert.equal(error.message, 'Path is not readable');
      assert.equal(error.path, path.resolve(root, 'missing.txt'));
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot reports PATH_UNREADABLE when lstat fails for a reason other than absence', () => {
  const root = scratchRoot();
  // A NUL byte in the path makes lstat throw ERR_INVALID_ARG_VALUE, not ENOENT,
  // so the error mapping has to fall through to PATH_UNREADABLE. A too-long
  // path would not do: Windows reports ENOENT for it.
  try {
    assert.throws(() => readFileWithinRoot(root, 'bad\u0000name'), (error) => {
      assert.equal(error.code, 'PATH_UNREADABLE');
      assert.equal(error.message, 'Path is not readable');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot reports PATH_UNREADABLE when the file cannot be read', () => {
  // Only a non-root POSIX user is denied by mode bits; root ignores them and
  // Windows has no equivalent, so the case cannot be exercised there.
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return;
  const root = scratchRoot();
  const unreadable = path.join(root, 'unreadable');
  try {
    fs.writeFileSync(unreadable, 'secret');
    fs.chmodSync(unreadable, 0o000);
    assert.throws(() => readFileWithinRoot(root, 'unreadable'), (error) => {
      assert.equal(error.code, 'PATH_UNREADABLE');
      assert.equal(error.message, 'Path is not readable');
      return true;
    });
  } finally {
    fs.chmodSync(unreadable, 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot refuses a symbolic link to a file inside the root', () => {
  const root = scratchRoot();
  try {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'inside');
    const link = path.join(root, 'link.txt');
    fs.symlinkSync(target, link);
    assert.throws(() => readFileWithinRoot(root, 'link.txt'), (error) => {
      assert.equal(error.code, 'PATH_SYMLINK');
      assert.equal(error.message, 'Path is a symbolic link');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The identity gate (fstat vs the lstat that admitted the path) and the ELOOP
// mapping only fire when the filesystem changes between two syscalls, which
// cannot be staged deterministically. Mocking the fs boundary is the only way
// to execute those branches.
test('readFileWithinRoot reports PATH_CHANGED when the opened file is not the one that was checked', (t) => {
  const root = scratchRoot();
  try {
    fs.writeFileSync(path.join(root, 'swap.txt'), 'x');
    t.mock.method(fs, 'fstatSync', () => ({ isFile: () => true, dev: 1n, ino: 999n }));
    assert.throws(() => readFileWithinRoot(root, 'swap.txt'), (error) => {
      assert.equal(error.code, 'PATH_CHANGED');
      assert.equal(error.message, 'Path changed between check and read');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot reports PATH_NOT_REGULAR when the opened file is not regular', (t) => {
  const root = scratchRoot();
  try {
    fs.writeFileSync(path.join(root, 'swap.txt'), 'x');
    t.mock.method(fs, 'fstatSync', () => ({ isFile: () => false, dev: 1n, ino: 1n }));
    assert.throws(() => readFileWithinRoot(root, 'swap.txt'), (error) => {
      assert.equal(error.code, 'PATH_NOT_REGULAR');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot maps ELOOP from the open to PATH_SYMLINK', (t) => {
  const root = scratchRoot();
  try {
    fs.writeFileSync(path.join(root, 'loop.txt'), 'x');
    t.mock.method(fs, 'openSync', () => {
      const error = new Error('too many levels of symbolic links');
      error.code = 'ELOOP';
      throw error;
    });
    assert.throws(() => readFileWithinRoot(root, 'loop.txt'), (error) => {
      assert.equal(error.code, 'PATH_SYMLINK');
      assert.equal(error.message, 'Path is a symbolic link');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot refuses a directory as PATH_NOT_REGULAR', () => {
  const root = scratchRoot();
  try {
    fs.mkdirSync(path.join(root, 'dir'));
    assert.throws(() => readFileWithinRoot(root, 'dir'), (error) => {
      assert.equal(error.code, 'PATH_NOT_REGULAR');
      assert.equal(error.message, 'Path is not a regular file');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot refuses a FIFO as PATH_NOT_REGULAR without blocking', () => {
  const root = scratchRoot();
  const fifo = path.join(root, 'pipe');
  try {
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo (Windows, or a filesystem that forbids FIFOs)
    }
    // Git for Windows ships an `mkfifo` that reports success but leaves no FIFO
    // on NTFS. Only a real FIFO exercises the non-regular refusal.
    let isRealFifo = false;
    try {
      isRealFifo = fs.lstatSync(fifo).isFIFO();
    } catch {
      isRealFifo = false;
    }
    if (!isRealFifo) return;
    const started = Date.now();
    assert.throws(() => readFileWithinRoot(root, 'pipe'), (error) => {
      assert.equal(error.code, 'PATH_NOT_REGULAR');
      assert.equal(error.message, 'Path is not a regular file');
      return true;
    });
    assert.ok(Date.now() - started < 5000, 'reading a FIFO must not block');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFileWithinRoot refuses a candidate outside the root', () => {
  const root = scratchRoot();
  const outside = scratchRoot();
  try {
    const file = path.join(outside, 'outside.txt');
    fs.writeFileSync(file, 'outside');
    assert.throws(() => readFileWithinRoot(root, file), (error) => {
      assert.equal(error.code, 'PATH_OUTSIDE_ALLOWED_ROOT');
      assert.equal(error.message, 'Path escapes allowed root');
      return true;
    });
    assert.throws(() => readFileWithinRoot(root, path.join('..', path.basename(outside), 'outside.txt')), (error) => {
      assert.equal(error.code, 'PATH_OUTSIDE_ALLOWED_ROOT');
      assert.equal(error.message, 'Path escapes allowed root');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('readFileWithinRoot treats an empty root or candidate as a contained-but-absent path', () => {
  const root = scratchRoot();
  try {
    const file = path.join(root, 'here.txt');
    fs.writeFileSync(file, 'here');
    // `path.resolve(root, '')` is the root itself, which is a directory.
    assert.throws(() => readFileWithinRoot(root, ''), (error) => {
      assert.equal(error.code, 'PATH_NOT_REGULAR');
      assert.equal(error.message, 'Path is not a regular file');
      return true;
    });
    // An empty root fails the shared root gate before any read is attempted.
    assert.throws(() => readFileWithinRoot('', path.relative(process.cwd(), file)), (error) => {
      assert.equal(error.code, 'ROOT_PATH_REQUIRED');
      assert.equal(error.message, 'rootPath is required');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
