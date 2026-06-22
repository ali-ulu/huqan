const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolvePersistencePaths } = require('../persistencePaths');
const { resolveDbPath: resolveMemoryStoreDbPath } = require('../lib/memory-store-utils');
const AxiomStorage = require('../storage');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-paths-'));
}

function cleanupPath(targetPath) {
  if (!targetPath) return;
  fs.rmSync(targetPath, { force: true, recursive: true });
}

function expectEscape(fn) {
  assert.throws(fn, (error) => {
    assert.strictEqual(error.code, 'AXIOM_PATH_OUTSIDE_WORKSPACE');
    assert.match(error.message, /Persistence path escapes workspace/);
    return true;
  });
}

describe('persistencePaths security confinement', () => {
  it('safe defaults stay inside workspace', () => {
    const rootDir = makeWorkspace();
    const result = resolvePersistencePaths({ rootDir });
    assert.strictEqual(result.rootDir, path.resolve(rootDir));
    for (const target of [result.memoryPath, result.dbPath, result.backupBaseDir]) {
      const relative = path.relative(result.rootDir, target);
      assert.ok(relative === '' || (!path.isAbsolute(relative) && !relative.startsWith('..')));
    }
  });

  it('safe relative custom paths resolve inside workspace', () => {
    const rootDir = makeWorkspace();
    const result = resolvePersistencePaths({
      rootDir,
      memoryPath: path.join('data', 'memory.json'),
      dbPath: path.join('data', 'memory.db'),
      backupBaseDir: 'backups',
    });
    assert.strictEqual(result.memoryPath, path.join(path.resolve(rootDir), 'data', 'memory.json'));
    assert.strictEqual(result.dbPath, path.join(path.resolve(rootDir), 'data', 'memory.db'));
    assert.strictEqual(result.backupBaseDir, path.join(path.resolve(rootDir), 'backups'));
  });

  it('rejects traversal that escapes workspace', () => {
    const rootDir = makeWorkspace();
    expectEscape(() => resolvePersistencePaths({ rootDir, memoryPath: '../memory.json' }));
    expectEscape(() => resolvePersistencePaths({ rootDir, dbPath: '../../outside.db' }));
    expectEscape(() => resolvePersistencePaths({ rootDir, backupBaseDir: '../backups' }));
  });

  it('rejects absolute paths outside workspace', () => {
    const rootDir = makeWorkspace();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-outside-'));
    expectEscape(() => resolvePersistencePaths({ rootDir, memoryPath: path.join(outsideRoot, 'memory.json') }));
    expectEscape(() => resolvePersistencePaths({ rootDir, dbPath: path.join(outsideRoot, 'memory.db') }));
    expectEscape(() => resolvePersistencePaths({ rootDir, backupBaseDir: path.join(outsideRoot, 'backups') }));
  });

  it('accepts absolute paths inside an explicit workspaceRoot', () => {
    const workspaceRoot = makeWorkspace();
    const memoryPath = path.join(workspaceRoot, 'memory.json');
    const dbPath = path.join(workspaceRoot, 'memory.db');
    const backupBaseDir = path.join(workspaceRoot, 'backups');
    const result = resolvePersistencePaths({
      rootDir: process.cwd(),
      workspaceRoot,
      memoryPath,
      dbPath,
      backupBaseDir,
    });
    assert.strictEqual(result.workspaceRoot, path.resolve(workspaceRoot));
    assert.strictEqual(result.memoryPath, memoryPath);
    assert.strictEqual(result.dbPath, dbPath);
    assert.strictEqual(result.backupBaseDir, backupBaseDir);
  });

  it('rejects prefix tricks that only look like descendants', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-prefix-parent-'));
    const rootDir = path.join(parent, 'work');
    const fakeDescendant = path.join(parent, 'work-evil', 'memory.json');
    fs.mkdirSync(rootDir, { recursive: true });
    expectEscape(() => resolvePersistencePaths({ rootDir, memoryPath: fakeDescendant }));
  });

  it('rejects absolute paths outside explicit workspaceRoot', () => {
    const workspaceRoot = makeWorkspace();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-explicit-outside-'));
    expectEscape(() => resolvePersistencePaths({
      rootDir: process.cwd(),
      workspaceRoot,
      memoryPath: path.join(outsideRoot, 'memory.json'),
    }));
  });

  it('rejects explicit workspaceRoot prefix tricks', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-explicit-prefix-parent-'));
    const workspaceRoot = path.join(parent, 'work');
    const fakeDescendant = path.join(parent, 'work-evil', 'memory.json');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    expectEscape(() => resolvePersistencePaths({
      rootDir: process.cwd(),
      workspaceRoot,
      memoryPath: fakeDescendant,
    }));
  });

  it('rejects null-byte path input', () => {
    const rootDir = makeWorkspace();
    expectEscape(() => resolvePersistencePaths({ rootDir, memoryPath: 'memory\u0000.json' }));
  });

  it('does not create files outside workspace when rejection happens', () => {
    const rootDir = makeWorkspace();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-no-create-'));
    const outsideMemory = path.join(outsideRoot, 'memory.json');
    expectEscape(() => resolvePersistencePaths({ rootDir, memoryPath: outsideMemory }));
    assert.strictEqual(fs.existsSync(outsideMemory), false);
  });

  it('confines memory-store SQLite fallback to explicit workspace root', () => {
    const workspaceRoot = makeWorkspace();
    const resolved = resolveMemoryStoreDbPath({
      rootDir: process.cwd(),
      workspaceRoot,
    });
    assert.strictEqual(resolved, path.join(workspaceRoot, 'memory.db'));
  });

  it('rejects memory-store explicit SQLite path outside explicit workspace root', () => {
    const workspaceRoot = makeWorkspace();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-db-outside-'));
    expectEscape(() => resolveMemoryStoreDbPath({
      rootDir: process.cwd(),
      workspaceRoot,
      dbPath: path.join(outsideRoot, 'memory.db'),
    }));
  });

  it('confines storage SQLite fallback to explicit workspace root', () => {
    const workspaceRoot = makeWorkspace();
    const storage = new AxiomStorage({
      rootDir: process.cwd(),
      workspaceRoot,
    });
    try {
      assert.strictEqual(storage.dbPath, path.join(workspaceRoot, 'memory.db'));
      assert.ok(fs.existsSync(storage.dbPath));
    } finally {
      storage.close();
      cleanupPath(storage.dbPath);
      cleanupPath(storage.dbPath + '-shm');
      cleanupPath(storage.dbPath + '-wal');
      cleanupPath(workspaceRoot);
    }
  });

  it('rejects storage explicit SQLite path outside explicit workspace root', () => {
    const workspaceRoot = makeWorkspace();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-storage-outside-'));
    try {
      expectEscape(() => new AxiomStorage({
        rootDir: process.cwd(),
        workspaceRoot,
        dbPath: path.join(outsideRoot, 'memory.db'),
      }));
    } finally {
      cleanupPath(workspaceRoot);
      cleanupPath(outsideRoot);
    }
  });
});
