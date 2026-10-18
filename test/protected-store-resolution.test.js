'use strict';

// The acceptance criterion of #3998 (ADR-018 §2, last bullet): "when the
// protected store is selected, resolution never falls back to the working
// directory."
//
// Three resolvers derive a default from the working directory -- the graph's
// `resolveDefaultMemoryPath`, the CLI/backup `resolvePersistencePaths`, and
// AgentV3's `defaultAgentV3DbPath`. Each is exercised here with a marker in
// place, and each must return the protected path and never a cwd-relative one.
//
// The test runs a real CLI subprocess for the strongest case: with a marker and
// a real protected store, `huqan`'s default store is the protected one, and no
// `memory.db` appears in the working directory.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  MARKER_VERSION,
  migrationMarkerPath,
  protectedMemoryDbPath,
  protectedMemoryJsonPath,
} = require('../lib/protected-store-path');
const { migrateStore } = require('../lib/authority/store-migrate');

const CLI_PATH = path.join(__dirname, '..', 'cli.js');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

function tempDir(t, prefix = 'huqan-protected-resolve-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The spelling a path has once the filesystem resolves it: symlinks expanded
 * and the spelling normalized. `os.tmpdir()` is `/var/folders/...` on macOS
 * while its real path is `/private/var/folders/...`, and `resolvePersistencePaths`
 * canonicalizes through its containment gate while `protectedMemoryJsonPath`
 * composes the raw spelling. Comparing the two spellings directly would then
 * fail on macOS for a reason unrelated to which store was selected, so both
 * sides are canonicalized. The target file does not exist yet in these tests,
 * so the nearest existing ancestor is canonicalized and the missing tail is
 * re-appended.
 */
function canonicalPath(target) {
  const resolved = path.resolve(target);
  let existing = resolved;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

/**
 * Select the protected store for `workspace` by writing a marker and the copy
 * it names. The marker's hash must match the copy for check (c) to pass, so the
 * copy is written first and hashed here. The copy is a real SQLite database
 * when better-sqlite3 is available, because the CLI opens it as one.
 */
function selectProtectedStore(workspace, stateRoot, { withJson = false } = {}) {
  const crypto = require('node:crypto');
  const dbPath = protectedMemoryDbPath(workspace, stateRoot);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (Database) {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, payload TEXT)');
    db.close();
  } else {
    fs.writeFileSync(dbPath, Buffer.from('protected-store-bytes'));
  }
  const dbSha256 = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const marker = {
    v: MARKER_VERSION,
    workspaceId: path.basename(path.dirname(dbPath)),
    migratedAt: new Date().toISOString(),
    sourceDir: path.join(workspace, 'profile'),
    dbSha256,
    dbTables: {},
    memoryJson: { present: false, status: 'absent' },
  };
  if (withJson) {
    fs.writeFileSync(protectedMemoryJsonPath(workspace, stateRoot), JSON.stringify({ nodes: {}, edges: [] }));
    marker.memoryJson = { present: true, sha256: crypto.createHash('sha256').update(fs.readFileSync(protectedMemoryJsonPath(workspace, stateRoot))).digest('hex'), counts: { nodes: 0, edges: 0 } };
  }
  fs.writeFileSync(migrationMarkerPath(workspace, stateRoot), JSON.stringify(marker, null, 2));
  return { dbPath, memoryPath: protectedMemoryJsonPath(workspace, stateRoot) };
}

describe('resolution never falls back to cwd once the protected store is selected', () => {
  it('resolveDefaultMemoryPath returns the protected path, not memory.json in cwd', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const { memoryPath } = selectProtectedStore(workspace, stateRoot);
    const cwd = process.cwd();
    const saved = process.env.HUQAN_PROTECTED_STATE_ROOT;
    process.env.HUQAN_PROTECTED_STATE_ROOT = stateRoot;
    try {
      process.chdir(workspace);
      // Re-require so the leaf reads the fresh environment through process.env.
      delete require.cache[require.resolve('../lib/default-persistence-path')];
      const { resolveDefaultMemoryPath } = require('../lib/default-persistence-path');
      const resolved = resolveDefaultMemoryPath();
      assert.equal(resolved, memoryPath, 'the protected path wins over the cwd default');
      assert.notEqual(path.resolve(resolved), path.resolve(workspace, 'memory.json'));
    } finally {
      process.chdir(cwd);
      if (saved === undefined) delete process.env.HUQAN_PROTECTED_STATE_ROOT;
      else process.env.HUQAN_PROTECTED_STATE_ROOT = saved;
      delete require.cache[require.resolve('../lib/default-persistence-path')];
    }
  });

  it('resolvePersistencePaths returns the protected store, not cwd-relative paths', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const { dbPath, memoryPath } = selectProtectedStore(workspace, stateRoot, { withJson: true });
    const saved = process.env.HUQAN_PROTECTED_STATE_ROOT;
    process.env.HUQAN_PROTECTED_STATE_ROOT = stateRoot;
    try {
      delete require.cache[require.resolve('../persistencePaths')];
      delete require.cache[require.resolve('../lib/protected-store-path')];
      const { resolvePersistencePaths } = require('../persistencePaths');
      const resolved = resolvePersistencePaths({ rootDir: workspace });
      assert.equal(canonicalPath(resolved.memoryPath), canonicalPath(memoryPath));
      assert.equal(canonicalPath(resolved.dbPath), canonicalPath(dbPath));
      assert.equal(canonicalPath(resolved.memoryPath).startsWith(canonicalPath(workspace)), false, 'not derived from cwd');
    } finally {
      if (saved === undefined) delete process.env.HUQAN_PROTECTED_STATE_ROOT;
      else process.env.HUQAN_PROTECTED_STATE_ROOT = saved;
      delete require.cache[require.resolve('../persistencePaths')];
      delete require.cache[require.resolve('../lib/protected-store-path')];
    }
  });

  it('an explicit opts.memoryPath still wins over the protected store', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    selectProtectedStore(workspace, stateRoot, { withJson: true });
    const saved = process.env.HUQAN_PROTECTED_STATE_ROOT;
    process.env.HUQAN_PROTECTED_STATE_ROOT = stateRoot;
    try {
      delete require.cache[require.resolve('../persistencePaths')];
      delete require.cache[require.resolve('../lib/protected-store-path')];
      const { resolvePersistencePaths } = require('../persistencePaths');
      const explicit = path.join(workspace, 'named.json');
      const resolved = resolvePersistencePaths({ rootDir: workspace, memoryPath: explicit });
      assert.equal(canonicalPath(resolved.memoryPath), canonicalPath(explicit), 'a caller who named a path is not second-guessed');
    } finally {
      if (saved === undefined) delete process.env.HUQAN_PROTECTED_STATE_ROOT;
      else process.env.HUQAN_PROTECTED_STATE_ROOT = saved;
      delete require.cache[require.resolve('../persistencePaths')];
      delete require.cache[require.resolve('../lib/protected-store-path')];
    }
  });

  it('defaultAgentV3DbPath returns the protected db for a pathless graph', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const { dbPath } = selectProtectedStore(workspace, stateRoot);
    const saved = process.env.HUQAN_PROTECTED_STATE_ROOT;
    process.env.HUQAN_PROTECTED_STATE_ROOT = stateRoot;
    const cwd = process.cwd();
    try {
      process.chdir(workspace);
      delete require.cache[require.resolve('../lib/agent-v3-storage-factory')];
      delete require.cache[require.resolve('../lib/protected-store-path')];
      const { defaultAgentV3DbPath } = require('../lib/agent-v3-storage-factory');
      assert.equal(defaultAgentV3DbPath({ graph: {} }), dbPath);
    } finally {
      process.chdir(cwd);
      if (saved === undefined) delete process.env.HUQAN_PROTECTED_STATE_ROOT;
      else process.env.HUQAN_PROTECTED_STATE_ROOT = saved;
      delete require.cache[require.resolve('../lib/agent-v3-storage-factory')];
      delete require.cache[require.resolve('../lib/protected-store-path')];
    }
  });

  it('the CLI writes its default store into the protected root, not the working directory', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const env = { ...process.env, HUQAN_PROTECTED_STATE_ROOT: stateRoot, HUQAN_STATE_ROOT: path.join(stateRoot, 'local') };
    const runCli = () => spawnSync(process.execPath, [CLI_PATH, 'kaydet'], {
      cwd: workspace, encoding: 'utf8', timeout: 60000, env,
    });
    // 1. Build a real profile store in the workspace with the CLI itself.
    const first = runCli();
    assert.equal(fs.existsSync(path.join(workspace, 'memory.db')), true, `the profile store is created first (stderr: ${first.stderr})`);
    // 2. Migrate it into the protected root with the real command core.
    const migrated = migrateStore({
      workspaceRoot: workspace, sourceDir: workspace, stateRoot, isElevated: true,
      applyAcl: () => ({ applied: true }),
    });
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    // 3. Remove the profile store: only the protected copy remains.
    for (const name of ['memory.db', 'memory.json', 'memory.db-wal', 'memory.db-shm']) {
      fs.rmSync(path.join(workspace, name), { force: true });
    }
    // 4. The CLI now resolves to the protected store and recreates nothing in cwd.
    const second = runCli();
    assert.equal(fs.existsSync(path.join(workspace, 'memory.db')), false, `no cwd memory.db after migration (stderr: ${second.stderr})`);
    assert.equal(fs.existsSync(path.join(workspace, 'memory.json')), false, 'no cwd memory.json after migration');
    assert.equal(fs.existsSync(protectedMemoryDbPath(workspace, stateRoot)), true, 'the protected store is the one in use');
  });
});
